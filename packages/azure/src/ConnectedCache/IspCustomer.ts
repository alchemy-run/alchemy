import * as connectedcache from "@distilled.cloud/azure/connectedcache";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createConnectedCacheName,
  deleteUntilGone,
  MCC_BUDGET,
  sameArm,
  whileCacheNodesExist,
} from "./Common.ts";

/** How the ISP reaches Microsoft content: directly, through a transit provider, or both. */
export type IspTransitState = "NoTransit" | "CombinedTransit" | "TransitOnly";

export interface IspCustomerProps {
  /**
   * Resource group the customer is created in. Changing it replaces the
   * customer.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Customer resource name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the customer.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the customer resource. Connected Cache for ISPs is
   * available in `westus`, `northeurope`, and `koreacentral` only.
   * Changing it replaces the customer.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Display name of the ISP in the Connected Cache portal. Azure ignores
   * changes after creation, so changing it replaces the customer.
   * @default the resource name
   */
  customerName?: string;
  /**
   * Email address of the ISP's Connected Cache contact.
   * @default none
   */
  contactEmail?: string;
  /**
   * Full name of the ISP's Connected Cache contact.
   * @default none
   */
  contactName?: string;
  /**
   * Phone number of the ISP's Connected Cache contact.
   * @default none
   */
  contactPhone?: string;
  /**
   * Autonomous system number (ASN) the ISP signs up with. Microsoft verifies
   * it against the ISP's PeeringDB record before cache nodes can be created.
   * Azure rejected a private ASN (`64512`) with `InternalServerError`.
   * @default none
   */
  asn?: string;
  /**
   * ASN of the ISP's transit provider, when `transitState` is not `NoTransit`.
   * @default none
   */
  transitAsn?: string;
  /**
   * Whether the ISP serves content directly, through transit, or both.
   * @default none
   */
  transitState?: IspTransitState;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface IspCustomer extends Resource<
  "Azure.ConnectedCache.IspCustomer",
  IspCustomerProps,
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
    /** Display name of the ISP. */
    customerName: string | undefined;
    /** Email address of the ISP's contact. */
    contactEmail: string | undefined;
    /** Full name of the ISP's contact. */
    contactName: string | undefined;
    /** Phone number of the ISP's contact. */
    contactPhone: string | undefined;
    /** ASN the ISP signed up with, if any. */
    asn: string | undefined;
    /** ASN of the ISP's transit provider, if any. */
    transitAsn: string | undefined;
    /** Transit state of the ISP. */
    transitState: string | undefined;
    /**
     * Whether the ISP signup has completed. Cache nodes can only be created
     * after it has.
     */
    signupStatus: boolean | undefined;
    /** Signup status text, e.g. `Not signed up.` */
    signupStatusText: string | undefined;
    /** ARM provisioning state of the customer resource. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Connected Cache for ISPs customer
 * (`Microsoft.ConnectedCache/ispCustomers`) — the "Connected Cache
 * resource" an internet service provider signs up with to run cache nodes
 * that serve Microsoft content (Windows Update, Xbox, Office) inside its own
 * network.
 *
 * The ARM resource itself is free. Signup completes after Microsoft
 * verifies the ISP's ASN against PeeringDB, which is outside Alchemy; only
 * then can `Azure.ConnectedCache.IspCacheNode` resources be created under
 * it.
 *
 * :::caution
 * Changing `name`, `location`, `resourceGroup`, or `customerName` replaces
 * the customer and deletes its cache nodes.
 * :::
 *
 * See [Connected Cache for ISPs sign-up](https://learn.microsoft.com/windows/deployment/do/mcc-isp-signup).
 *
 * ### Creating a Customer
 * **Example:** ISP customer with a contact
 * ```typescript
 * const isp = yield* Azure.ConnectedCache.IspCustomer("isp", {
 *   location: "westus",
 *   customerName: "Contoso Broadband",
 *   contactName: "Network Operations",
 *   contactEmail: "noc@contoso.example",
 * });
 * ```
 *
 * ### Signing Up With an ASN
 * **Example:** ISP customer that reaches Microsoft through a transit provider
 * ```typescript
 * yield* Azure.ConnectedCache.IspCustomer("isp", {
 *   location: "northeurope",
 *   asn: "65010",
 *   transitState: "CombinedTransit",
 *   transitAsn: "65020",
 * });
 * ```
 *
 * @resource
 */
export const IspCustomer = GroupedResource<IspCustomer>("Azure.ConnectedCache.IspCustomer");

type ObservedCustomer = connectedcache.GetIspCustomerResponse | connectedcache.IspCustomerResource;

const getCustomer = (
  subscriptionId: string,
  resourceGroupName: string,
  customerResourceName: string,
) =>
  orUndefinedIfNotFound(
    connectedcache.GetIspCustomer({
      subscriptionId,
      resourceGroupName,
      customerResourceName,
    }),
  );

/** The RP returns `""` for unset strings. */
const orUndefined = (value: string | undefined) => (value === "" ? undefined : value);

const toAttrs = (
  resourceGroup: string,
  name: string,
  customer: ObservedCustomer,
): IspCustomer["Attributes"] => {
  const entity = customer.properties?.customer;
  const extra = customer.properties?.additionalCustomerProperties;
  return {
    customerResourceName: name,
    customerResourceId: customer.id ?? "",
    resourceGroup,
    location: customer.location,
    customerId: entity?.customerId,
    clientTenantId: entity?.clientTenantId,
    customerName: entity?.customerName,
    contactEmail: orUndefined(entity?.contactEmail),
    contactName: orUndefined(entity?.contactName),
    contactPhone: orUndefined(entity?.contactPhone),
    asn: orUndefined(extra?.customerAsn),
    transitAsn: orUndefined(extra?.customerTransitAsn),
    transitState: extra?.customerTransitState,
    signupStatus: extra?.signupStatus,
    signupStatusText: extra?.signupStatusText,
    provisioningState: customer.properties?.provisioningState,
    tags: userTags(customer.tags),
  };
};

/** Whether a desired (defined) field differs from the observed one. */
const fieldDiffers = <T>(desired: T | undefined, observed: T | undefined) =>
  desired !== undefined && desired !== observed;

export const IspCustomerProvider = () =>
  Provider.succeed(IspCustomer, {
    stables: [
      "customerResourceName",
      "customerResourceId",
      "resourceGroup",
      "location",
      "customerId",
      "clientTenantId",
    ],

    // The list response omits tags and reports the display name as `name`,
    // so each customer is re-read by the name in its ARM ID.
    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(connectedcache.ListIspCustomerBySubscription, {
        subscriptionId,
      });
      const owned = yield* Effect.forEach(page.value ?? [], (listed) =>
        Effect.gen(function* () {
          const group = resourceGroupOf(listed.id);
          const name = listed.id?.split("/").at(-1);
          if (group === undefined || name === undefined) return [];
          const customer = yield* getCustomer(subscriptionId, group, name);
          return customer !== undefined && hasAnyAlchemyTag(customer.tags)
            ? [toAttrs(group, name, customer)]
            : [];
        }),
      );
      return owned.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.customerResourceName)) ||
        (news.location !== undefined && !sameArm(news.location, output.location)) ||
        (news.customerName !== undefined && news.customerName !== output.customerName)
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
        output?.customerResourceName ?? olds?.name ?? (yield* createConnectedCacheName(id));
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
        news.name ?? output?.customerResourceName ?? (yield* createConnectedCacheName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        customerResourceName: name,
      };
      const get = getCustomer(subscriptionId, resourceGroup, name);
      const label = `Connected Cache ISP customer ${name}`;
      const signup =
        news.asn !== undefined || news.transitAsn !== undefined || news.transitState !== undefined
          ? {
              customerAsn: news.asn,
              customerTransitAsn: news.transitAsn,
              customerTransitState: news.transitState,
            }
          : undefined;
      const put = (location: string) =>
        connectedcache.IspCustomersCreateOrUpdate({
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
            additionalCustomerProperties: signup,
          },
        });
      // Replicas of the RP can briefly serve the pre-PUT body, so a write
      // is settled only once the desired fields are observed.
      const fieldsDiffer = (customer: ObservedCustomer) => {
        const entity = customer.properties?.customer;
        const extra = customer.properties?.additionalCustomerProperties;
        // `customerName` is create-only (diff replaces on a change).
        return (
          fieldDiffers(news.contactEmail, entity?.contactEmail) ||
          fieldDiffers(news.contactName, entity?.contactName) ||
          fieldDiffers(news.contactPhone, entity?.contactPhone) ||
          fieldDiffers(news.asn, extra?.customerAsn) ||
          fieldDiffers(news.transitAsn, extra?.customerTransitAsn) ||
          fieldDiffers<string>(news.transitState, extra?.customerTransitState)
        );
      };
      const settled = (customer: ObservedCustomer) =>
        fieldsDiffer(customer) ? "Updating" : customer.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. The create is asynchronous: GET reports not-found until the
      // RP has stored the customer.
      if (observed === undefined) {
        yield* put(news.location ?? output?.location ?? env.location);
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (customer) => customer.properties?.provisioningState,
        MCC_BUDGET,
      );

      // Sync customer fields (PUT only) against observed state.
      if (fieldsDiffer(observed)) {
        yield* put(observed.location);
        observed = yield* waitForProvisioned(label, get, settled, MCC_BUDGET);
      }

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* connectedcache.UpdateIspCustomer({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (customer) =>
            tagsDiffer(customer.tags, tags) ? "Updating" : customer.properties?.provisioningState,
          MCC_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* deleteUntilGone(
        `Connected Cache ISP customer ${output.customerResourceName}`,
        ignoreNotFound(
          connectedcache
            .DeleteIspCustomer({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              customerResourceName: output.customerResourceName,
            })
            .pipe(Effect.retry(whileCacheNodesExist)),
        ),
        getCustomer(subscriptionId, output.resourceGroup, output.customerResourceName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
