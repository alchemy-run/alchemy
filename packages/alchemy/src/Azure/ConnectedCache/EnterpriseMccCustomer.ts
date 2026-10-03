import * as connectedcache from "@distilled.cloud/azure/connectedcache";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createConnectedCacheName,
  MCC_BUDGET,
  sameArm,
  whileCacheNodesExist,
} from "./Common.ts";

export interface EnterpriseMccCustomerProps {
  /**
   * Resource group the customer is created in. Changing it replaces the
   * customer.
   */
  resourceGroup: string;
  /**
   * Customer resource name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the customer.
   */
  name?: string;
  /**
   * Azure location of the customer resource. Connected Cache for Enterprise
   * is available in `westus`, `northeurope`, and `koreacentral` only.
   * Changing it replaces the customer.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Display name of the customer (organization) in the Connected Cache
   * portal.
   */
  customerName?: string;
  /** Email address of the customer's Connected Cache contact. */
  contactEmail?: string;
  /** Full name of the customer's Connected Cache contact. */
  contactName?: string;
  /** Phone number of the customer's Connected Cache contact. */
  contactPhone?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EnterpriseMccCustomer extends Resource<
  "Azure.ConnectedCache.EnterpriseMccCustomer",
  EnterpriseMccCustomerProps,
  {
    /** Name of the customer resource. */
    customerResourceName: string;
    /** ARM resource ID of the customer resource. */
    customerResourceId: string;
    /** Resource group that holds the customer resource. */
    resourceGroup: string;
    /** Location of the customer resource. */
    location: string;
    /** GUID the Connected Cache service assigns to the customer. */
    customerId: string | undefined;
    /** Tenant ID of the subscription that owns the customer. */
    clientTenantId: string | undefined;
    /** Whether the tenant is entitled to Connected Cache for Enterprise. */
    isEntitled: boolean | undefined;
    /** Display name of the customer. */
    customerName: string | undefined;
    /** Email address of the customer's contact. */
    contactEmail: string | undefined;
    /** Full name of the customer's contact. */
    contactName: string | undefined;
    /** Phone number of the customer's contact. */
    contactPhone: string | undefined;
    /** ARM provisioning state of the customer resource. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Connected Cache for Enterprise and Education customer — the
 * top-level "Connected Cache resource" that groups the cache nodes a
 * company runs on its own servers to cache Windows Update, Intune, and
 * Microsoft Store content.
 *
 * The ARM resource itself is free; caching happens on customer-hosted
 * servers registered against `Azure.ConnectedCache.EnterpriseMccCacheNode`
 * resources.
 *
 * @see https://learn.microsoft.com/windows/deployment/do/mcc-ent-edu-overview
 *
 * ### Creating a Customer
 * **Example:** Connected Cache customer with a contact
 * ```typescript
 * const customer = yield* Azure.ConnectedCache.EnterpriseMccCustomer("mcc", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus",
 *   contactName: "IT Operations",
 *   contactEmail: "it-ops@example.com",
 * });
 * ```
 *
 * ### Adding Cache Nodes
 * **Example:** Linux cache node under the customer
 * ```typescript
 * yield* Azure.ConnectedCache.EnterpriseMccCacheNode("node", {
 *   resourceGroup: group.resourceGroupName,
 *   customer: customer.customerResourceName,
 *   location: customer.location,
 *   osType: "Linux",
 *   driveConfiguration: [
 *     { physicalPath: "/var/mcc", sizeInGb: 100, cacheNumber: 1 },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const EnterpriseMccCustomer = Resource<EnterpriseMccCustomer>(
  "Azure.ConnectedCache.EnterpriseMccCustomer",
);

type ObservedCustomer =
  | connectedcache.GetEnterpriseMccCustomerResponse
  | connectedcache.EnterpriseMccCustomerResource;

const getCustomer = (
  subscriptionId: string,
  resourceGroupName: string,
  customerResourceName: string,
) =>
  orUndefinedIfNotFound(
    connectedcache.GetEnterpriseMccCustomer({
      subscriptionId,
      resourceGroupName,
      customerResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  customer: ObservedCustomer,
): EnterpriseMccCustomer["Attributes"] => ({
  customerResourceName: name,
  customerResourceId: customer.id ?? "",
  resourceGroup,
  location: customer.location,
  customerId: customer.properties?.customer?.customerId,
  clientTenantId: customer.properties?.customer?.clientTenantId,
  isEntitled: customer.properties?.customer?.isEntitled,
  customerName: customer.properties?.customer?.customerName,
  contactEmail: customer.properties?.customer?.contactEmail,
  contactName: customer.properties?.customer?.contactName,
  contactPhone: customer.properties?.customer?.contactPhone,
  provisioningState: customer.properties?.provisioningState,
  tags: userTags(customer.tags),
});

/** Whether a desired (defined) customer field differs from the observed one. */
const fieldDiffers = <T>(desired: T | undefined, observed: T | undefined) =>
  desired !== undefined && desired !== observed;

export const EnterpriseMccCustomerProvider = () =>
  Provider.succeed(EnterpriseMccCustomer, {
    stables: [
      "customerResourceName",
      "customerResourceId",
      "resourceGroup",
      "location",
      "customerId",
      "clientTenantId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* connectedcache
        .ListEnterpriseMccCustomerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListEnterpriseMccCustomerBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((customer) => {
        const group = resourceGroupOf(customer.id);
        return hasAnyAlchemyTag(customer.tags) &&
          group !== undefined &&
          customer.name !== undefined
          ? [toAttrs(group, customer.name, customer)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.customerResourceName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.customerResourceName ??
        olds?.name ??
        (yield* createConnectedCacheName(id));
      const observed = yield* getCustomer(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ConnectedCache");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.customerResourceName ??
        (yield* createConnectedCacheName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        customerResourceName: name,
      };
      const get = getCustomer(subscriptionId, resourceGroup, name);
      const label = `Connected Cache customer ${name}`;
      const put = (location: string) =>
        connectedcache.EnterpriseMccCustomersCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            customer: {
              customerName: news.customerName,
              contactEmail: news.contactEmail,
              contactName: news.contactName,
              contactPhone: news.contactPhone,
            },
          },
        });

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* put(news.location ?? output?.location ?? env.location);
      }
      // Replicas of the RP can briefly serve the pre-PUT body, so a write
      // is settled only once the desired contact details are observed.
      const contactDiffers = (customer: ObservedCustomer) => {
        const current = customer.properties?.customer;
        return (
          fieldDiffers(news.customerName, current?.customerName) ||
          fieldDiffers(news.contactEmail, current?.contactEmail) ||
          fieldDiffers(news.contactName, current?.contactName) ||
          fieldDiffers(news.contactPhone, current?.contactPhone)
        );
      };
      const settled = (customer: ObservedCustomer) =>
        contactDiffers(customer)
          ? "Updating"
          : customer.properties?.provisioningState;
      observed = yield* waitForProvisioned(
        label,
        get,
        (customer) => customer.properties?.provisioningState,
        MCC_BUDGET,
      );

      // Sync customer contact details (PUT only) against observed state.
      if (contactDiffers(observed)) {
        yield* put(observed.location);
        observed = yield* waitForProvisioned(label, get, settled, MCC_BUDGET);
      }

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* connectedcache.UpdateEnterpriseMccCustomer({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (customer) =>
            tagsDiffer(customer.tags, tags)
              ? "Updating"
              : customer.properties?.provisioningState,
          MCC_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        connectedcache
          .DeleteEnterpriseMccCustomer({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            customerResourceName: output.customerResourceName,
          })
          .pipe(Effect.retry(whileCacheNodesExist)),
      );
      yield* waitUntilGone(
        `Connected Cache customer ${output.customerResourceName}`,
        getCustomer(
          subscriptionId,
          output.resourceGroup,
          output.customerResourceName,
        ),
        MCC_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
