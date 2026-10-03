import * as apicenter from "@distilled.cloud/azure/apicenter";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createServiceName, getService, sameName } from "./Common.ts";

export type ApiCenterIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface ApiCenterServiceIdentity {
  /** Kind of managed identity attached to the service. */
  type: ApiCenterIdentityType;
  /**
   * ARM resource IDs of user-assigned identities (required when `type`
   * includes `UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface ServiceProps {
  /** Resource group that holds the service. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Service name: 3-50 letters, digits, and single hyphens. It forms the data API
   * hostname `{name}.data.{location}.azure-apicenter.ms`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the service.
   */
  name?: string;
  /**
   * Azure region. API Center is only available in some regions (e.g.
   * `eastus`, `westeurope`, `uksouth`, `swedencentral`, `australiaeast`,
   * `centralindia`, `francecentral`, `canadacentral`, `japaneast`).
   * Changing it replaces the service.
   * @default the stack's Azure location
   */
  location?: string;
  /**
   * Managed identity of the service, used to import APIs from API
   * Management.
   * @default no identity
   */
  identity?: ApiCenterServiceIdentity;
  /** User tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "Azure.ApiCenter.Service",
  ServiceProps,
  {
    /** Name of the service. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the service. */
    serviceId: string;
    /** Region of the service. */
    location: string;
    /** Data API hostname, `{name}.data.{location}.azure-apicenter.ms`. */
    dataApiHostname: string;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Provisioning state reported by ARM. */
    provisioningState: string | undefined;
    /** User tags (ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure API Center service: an inventory of the organization's APIs,
 * their versions, definitions, environments, and deployments.
 *
 * Services are created on the Free plan. Catalog entities ({@link Api},
 * {@link Environment}, {@link MetadataSchema}, ...) live in the service's
 * `default` workspace and are deleted with it.
 *
 * @see https://learn.microsoft.com/azure/api-center/overview
 *
 * ### Creating a Service
 * **Example:** API Center in East US
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("apis", {
 *   location: "eastus",
 * });
 * const center = yield* Azure.ApiCenter.Service("catalog", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Service with a system-assigned identity
 * ```typescript
 * const center = yield* Azure.ApiCenter.Service("catalog", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const Service = Resource<Service>("Azure.ApiCenter.Service");

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: apicenter.GetServiceResponse,
): Service["Attributes"] => ({
  serviceName: name,
  resourceGroup,
  serviceId: observed.id ?? "",
  location: observed.location,
  dataApiHostname: `${name}.data.${observed.location.toLowerCase().replaceAll(" ", "")}.azure-apicenter.ms`,
  principalId: observed.identity?.principalId,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

const toRequestIdentity = (identity: ApiCenterServiceIdentity | undefined) =>
  identity === undefined
    ? { type: "None" }
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

/** Whether the observed identity matches the desired one. */
const identityInSync = (
  desired: ApiCenterServiceIdentity | undefined,
  observed: apicenter.GetServiceResponse["identity"],
) => {
  const desiredType = (desired?.type ?? "None").replaceAll(" ", "");
  const observedType = (observed?.type ?? "None").replaceAll(" ", "");
  if (desiredType.toLowerCase() !== observedType.toLowerCase()) return false;
  const want = (desired?.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return (
    want.length === have.length && want.every((id, i) => id === have[i])
  );
};

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["serviceName", "resourceGroup", "serviceId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* apicenter
        .ListServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListServiceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
          ? [toAttrs(group, service.name, service)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.serviceName)) ||
        (news.location !== undefined &&
          !sameName(
            news.location.replaceAll(" ", ""),
            output.location.replaceAll(" ", ""),
          ))
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
        output?.serviceName ?? olds?.name ?? (yield* createServiceName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiCenter");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.serviceName ?? (yield* createServiceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serviceName: name,
      };
      const get = getService(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* apicenter.ServicesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity:
            news.identity === undefined
              ? undefined
              : toRequestIdentity(news.identity),
        });
      } else if (
        tagsDiffer(observed.tags, tags) ||
        !identityInSync(news.identity, observed.identity)
      ) {
        // Sync tags and identity against the observed service.
        yield* apicenter.UpdateService({
          ...where,
          tags,
          identity: toRequestIdentity(news.identity),
        });
      }

      const fresh = yield* waitForProvisioned(
        `API Center service ${name}`,
        get,
        (service) => service.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apicenter.DeleteService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
        }),
      );
      yield* waitUntilGone(
        `API Center service ${output.serviceName}`,
        getService(subscriptionId, output.resourceGroup, output.serviceName),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
