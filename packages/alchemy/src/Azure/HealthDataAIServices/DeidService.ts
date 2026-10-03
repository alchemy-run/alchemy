import * as healthdataaiservices from "@distilled.cloud/azure/healthdataaiservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export type DeidServiceIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface DeidServiceIdentity {
  /** Kind of managed identity attached to the de-identification service. */
  type: DeidServiceIdentityType;
  /**
   * ARM resource IDs of user-assigned identities (required when `type`
   * includes `UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface DeidServiceProps {
  /**
   * Resource group of the de-identification service. Changing it replaces
   * the service.
   */
  resourceGroup: string;
  /**
   * Name of the service: 3-24 letters, digits, and hyphens. It forms the
   * service URL. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the service.
   */
  name?: string;
  /**
   * Azure region. De-identification is available in a subset of regions
   * (e.g. `eastus`, `westus2`, `westus3`, `northeurope`, `uksouth`,
   * `centralindia`, `australiaeast`). Changing it replaces the service.
   * @default the stack's Azure location
   */
  location?: string;
  /**
   * Whether the data-plane endpoint accepts traffic from public networks.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Managed identity of the service.
   * @default no identity
   */
  identity?: DeidServiceIdentity;
  /** User tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface DeidService extends Resource<
  "Azure.HealthDataAIServices.DeidService",
  DeidServiceProps,
  {
    /** Name of the de-identification service. */
    deidServiceName: string;
    /** ARM resource ID of the de-identification service. */
    deidServiceId: string;
    /** Resource group of the de-identification service. */
    resourceGroup: string;
    /** Region of the de-identification service. */
    location: string;
    /**
     * Data-plane endpoint for de-identification jobs and realtime calls,
     * e.g. `https://{id}.api.eus001.deid.azure.com`.
     */
    serviceUrl: string | undefined;
    /** Whether public network access is enabled. */
    publicNetworkAccess: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if any. */
    tenantId: string | undefined;
    /** Provisioning state reported by ARM. */
    provisioningState: string | undefined;
    /** User tags (ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Health Data Services de-identification service, which removes or
 * surrogates protected health information (PHI) in unstructured text via
 * realtime calls or batch jobs. Billing is per MB of text processed, so an
 * idle service costs nothing.
 *
 * @see https://learn.microsoft.com/azure/healthcare-apis/deidentification/overview
 *
 * ### Creating a De-identification Service
 * **Example:** De-identification service in East US
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("health", {
 *   location: "eastus",
 * });
 * const deid = yield* Azure.HealthDataAIServices.DeidService("deid", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // deid.serviceUrl is the data-plane endpoint
 * ```
 *
 * ### Identity and Network Access
 * **Example:** System-assigned identity for batch jobs on Blob Storage
 * ```typescript
 * const deid = yield* Azure.HealthDataAIServices.DeidService("deid", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * // grant deid.principalId "Storage Blob Data Contributor" on the account
 * ```
 *
 * **Example:** Private-only service
 * ```typescript
 * const deid = yield* Azure.HealthDataAIServices.DeidService("deid", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const DeidService = Resource<DeidService>(
  "Azure.HealthDataAIServices.DeidService",
);

type ObservedDeidService = healthdataaiservices.GetDeidServiceResponse;

const createDeidServiceName = (id: string) =>
  createPhysicalName({ id, maxLength: 24, lowercase: true, delimiter: "-" });

const getDeidService = (
  subscriptionId: string,
  resourceGroupName: string,
  deidServiceName: string,
) =>
  orUndefinedIfNotFound(
    healthdataaiservices.GetDeidService({
      subscriptionId,
      resourceGroupName,
      deidServiceName,
    }),
  );

const lower = (value: string | undefined) =>
  value?.toLowerCase().replaceAll(" ", "");

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedDeidService,
): DeidService["Attributes"] => ({
  deidServiceName: name,
  deidServiceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  serviceUrl: observed.properties?.serviceUrl,
  publicNetworkAccess: observed.properties?.publicNetworkAccess,
  principalId: observed.identity?.principalId,
  tenantId: observed.identity?.tenantId,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

const toRequestIdentity = (identity: DeidServiceIdentity | undefined) =>
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

const identityInSync = (
  desired: DeidServiceIdentity | undefined,
  observed: ObservedDeidService["identity"],
) => {
  if (lower(desired?.type ?? "None") !== lower(observed?.type ?? "None")) {
    return false;
  }
  const want = (desired?.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.length === have.length && want.every((id, i) => id === have[i]);
};

export const DeidServiceProvider = () =>
  Provider.succeed(DeidService, {
    stables: ["deidServiceName", "deidServiceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* healthdataaiservices
        .ListDeidServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDeidServiceBySubscription", page),
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
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.deidServiceName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location))
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
        output?.deidServiceName ??
        olds?.name ??
        (yield* createDeidServiceName(id));
      const observed = yield* getDeidService(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HealthDataAIServices");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.deidServiceName ??
        (yield* createDeidServiceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        deidServiceName: name,
      };
      const label = `de-identification service ${name}`;
      const get = getDeidService(subscriptionId, resourceGroup, name);
      const settle = () =>
        waitForProvisioned(
          label,
          get,
          (service) => service.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* healthdataaiservices.CreateDeidService({
          ...where,
          location,
          tags,
          identity:
            news.identity === undefined
              ? undefined
              : toRequestIdentity(news.identity),
          properties:
            news.publicNetworkAccess === undefined
              ? undefined
              : { publicNetworkAccess: news.publicNetworkAccess },
        });
      }
      observed = yield* settle();

      // Sync network access, identity, and tags against observed state.
      const desiredAccess = news.publicNetworkAccess ?? "Enabled";
      const accessChanged =
        lower(observed.properties?.publicNetworkAccess ?? "Enabled") !==
        lower(desiredAccess);
      const identityChanged = !identityInSync(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (accessChanged || identityChanged || tagsChanged) {
        yield* healthdataaiservices.UpdateDeidService({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged
            ? toRequestIdentity(news.identity)
            : undefined,
          properties: accessChanged
            ? { publicNetworkAccess: desiredAccess }
            : undefined,
        });
        observed = yield* settle();
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        healthdataaiservices.DeleteDeidService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          deidServiceName: output.deidServiceName,
        }),
      );
      yield* waitUntilGone(
        `de-identification service ${output.deidServiceName}`,
        getDeidService(
          subscriptionId,
          output.resourceGroup,
          output.deidServiceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
