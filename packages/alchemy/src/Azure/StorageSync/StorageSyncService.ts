import * as storagesync from "@distilled.cloud/azure/storagesync";
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
import { createChildName, sameName } from "./internal.ts";

export type StorageSyncIdentityType = storagesync.ManagedServiceIdentityType;
export type IncomingTrafficPolicy = storagesync.IncomingTrafficPolicy;

export interface StorageSyncServiceIdentity {
  /** Managed identity type. */
  type: StorageSyncIdentityType;
  /**
   * ARM IDs of user-assigned identities to attach (required for
   * `UserAssigned` and `SystemAssigned,UserAssigned`).
   */
  userAssignedIdentityIds?: string[];
}

export interface StorageSyncServiceProps {
  /** Resource group the service is created in. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Name of the Storage Sync Service. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the service.
   */
  name?: string;
  /**
   * Azure location of the service. Changing it replaces the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Which networks may reach the service: `AllowAllTraffic` or
   * `AllowVirtualNetworksOnly` (private endpoints only).
   * @default "AllowAllTraffic"
   */
  incomingTrafficPolicy?: IncomingTrafficPolicy;
  /**
   * Authorize the service and its registered servers with managed identities
   * instead of shared keys/certificates. Enable it once the identities hold
   * the required RBAC roles on the storage accounts.
   * @default Azure's default (`false`)
   */
  useIdentity?: boolean;
  /** Managed identity of the service. */
  identity?: StorageSyncServiceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageSyncService extends Resource<
  "Azure.StorageSync.StorageSyncService",
  StorageSyncServiceProps,
  {
    /** Name of the Storage Sync Service. */
    storageSyncServiceName: string;
    /** ARM resource ID of the service. */
    storageSyncServiceId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Unique ID of the service, used by agents during server registration. */
    storageSyncServiceUid: string | undefined;
    /** Service status code. */
    storageSyncServiceStatus: number | undefined;
    /** Incoming traffic policy in effect. */
    incomingTrafficPolicy: string | undefined;
    /** Whether managed-identity authorization is enabled. */
    useIdentity: boolean | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if any. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure File Sync Storage Sync Service — the top-level resource that
 * groups sync groups (cloud + server endpoints) and the Windows servers
 * registered to sync with Azure file shares. The service itself is free.
 *
 * @see https://learn.microsoft.com/azure/storage/file-sync/file-sync-introduction
 *
 * ### Creating a Storage Sync Service
 * **Example:** Basic service
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("files");
 * const sync = yield* Azure.StorageSync.StorageSyncService("sync", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Private-endpoint-only service with a managed identity
 * ```typescript
 * const sync = yield* Azure.StorageSync.StorageSyncService("sync", {
 *   resourceGroup: group.resourceGroupName,
 *   incomingTrafficPolicy: "AllowVirtualNetworksOnly",
 *   identity: { type: "SystemAssigned" },
 *   tags: { team: "files" },
 * });
 * ```
 *
 * @resource
 */
export const StorageSyncService = Resource<StorageSyncService>(
  "Azure.StorageSync.StorageSyncService",
);

type Observed = storagesync.GetStorageSyncServiceResponse;

const createServiceName = (id: string) => createChildName(id, 60);

export const getStorageSyncService = (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
) =>
  orUndefinedIfNotFound(
    storagesync.GetStorageSyncService({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): StorageSyncService["Attributes"] => ({
  storageSyncServiceName: name,
  storageSyncServiceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  storageSyncServiceUid: observed.properties?.storageSyncServiceUid,
  storageSyncServiceStatus: observed.properties?.storageSyncServiceStatus,
  incomingTrafficPolicy: observed.properties?.incomingTrafficPolicy,
  useIdentity: observed.properties?.useIdentity,
  principalId: observed.identity?.principalId,
  tenantId: observed.identity?.tenantId,
  tags: userTags(observed.tags),
});

const normalizeType = (type: string | undefined) =>
  (type ?? "None").replace(/\s/g, "").toLowerCase();

const identityDiffers = (
  observed: Observed["identity"],
  desired: StorageSyncServiceIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if (normalizeType(observed?.type) !== normalizeType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((key) => key.toLowerCase())
    .sort()
    .join(",");
  const want = (desired.userAssignedIdentityIds ?? [])
    .map((key) => key.toLowerCase())
    .sort()
    .join(",");
  return have !== want;
};

const toIdentityInput = (
  identity: StorageSyncServiceIdentity | undefined,
): storagesync.CreateStorageSyncServiceRequestIdentity | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentityIds?.length
          ? Object.fromEntries(
              identity.userAssignedIdentityIds.map((armId) => [armId, {}]),
            )
          : undefined,
      };

export const StorageSyncServiceProvider = () =>
  Provider.succeed(StorageSyncService, {
    stables: [
      "storageSyncServiceName",
      "storageSyncServiceId",
      "resourceGroup",
      "location",
      "storageSyncServiceUid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        storagesync
          .ListStorageSyncServiceBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListStorageSyncServiceBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((service) => {
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
        (news.name !== undefined &&
          !sameName(news.name, output.storageSyncServiceName)) ||
        (news.location !== undefined &&
          !sameName(
            news.location.replace(/\s/g, ""),
            output.location.replace(/\s/g, ""),
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
        output?.storageSyncServiceName ??
        olds?.name ??
        (yield* createServiceName(id));
      const observed = yield* getStorageSyncService(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageSync");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.storageSyncServiceName ??
        (yield* createServiceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const incomingTrafficPolicy =
        news.incomingTrafficPolicy ?? "AllowAllTraffic";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageSyncServiceName: name,
      };
      const label = `storage sync service ${name}`;
      const get = getStorageSyncService(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* storagesync.CreateStorageSyncService({
          ...where,
          location,
          tags,
          identity: toIdentityInput(news.identity),
          properties: {
            incomingTrafficPolicy,
            useIdentity: news.useIdentity,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (service) => service.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Sync mutable aspects against the observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const properties: storagesync.StorageSyncServiceCreateParametersProperties =
        {};
      if (props.incomingTrafficPolicy !== incomingTrafficPolicy) {
        properties.incomingTrafficPolicy = incomingTrafficPolicy;
      }
      if (
        news.useIdentity !== undefined &&
        (props.useIdentity ?? false) !== news.useIdentity
      ) {
        properties.useIdentity = news.useIdentity;
      }
      const identityChanged = identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const propsChanged = Object.keys(properties).length > 0;
      if (propsChanged || identityChanged || tagsChanged) {
        yield* storagesync.UpdateStorageSyncService({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged
            ? toIdentityInput(news.identity)
            : undefined,
          properties: propsChanged ? properties : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (service) => service.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagesync.DeleteStorageSyncService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageSyncServiceName: output.storageSyncServiceName,
        }),
      );
      yield* waitUntilGone(
        `storage sync service ${output.storageSyncServiceName}`,
        getStorageSyncService(
          subscriptionId,
          output.resourceGroup,
          output.storageSyncServiceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
