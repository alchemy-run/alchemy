import * as discovery from "@distilled.cloud/azure/discovery";
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
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  lower,
  sameLocation,
} from "./common.ts";

/** The storage that backs a Discovery storage container. */
export type StorageContainerStore =
  | {
      /** Azure Blob Storage. */
      kind: "AzureStorageBlob";
      /** ARM ID of the storage account. */
      storageAccountId: string;
      /**
       * Mount protocol.
       * @default "BlobfuseCaching"
       */
      mountProtocol?: "NFS" | "BlobfuseCaching";
    }
  | {
      /** Azure NetApp Files. */
      kind: "AzureNetAppFiles";
      /** ARM ID of the NetApp volume. */
      netAppVolumeId: string;
      /**
       * Mount protocol.
       * @default "NFS"
       */
      mountProtocol?: "NFS";
    };

export interface StorageContainerProps {
  /**
   * Resource group the storage container is created in. Changing it
   * replaces the storage container.
   */
  resourceGroup: string;
  /**
   * Storage container name: 3-24 letters, digits, and hyphens. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the storage container.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the storage container.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * The backing store (Blob storage account or NetApp volume). Changing it
   * replaces the storage container.
   */
  storageStore: StorageContainerStore;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageContainer extends Resource<
  "Azure.Discovery.StorageContainer",
  StorageContainerProps,
  {
    /** Name of the storage container. */
    storageContainerName: string;
    /** ARM resource ID of the storage container. */
    storageContainerId: string;
    /** Resource group that holds the storage container. */
    resourceGroup: string;
    /** Location of the storage container. */
    location: string;
    /** Kind of the backing store. */
    storeKind: string;
    /** ARM ID of the backing storage account or NetApp volume. */
    storeResourceId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery storage container
 * (`Microsoft.Discovery/storageContainers`) — registers a Blob Storage
 * account or Azure NetApp Files volume as a data source that Discovery
 * projects and storage assets reference.
 *
 * Microsoft Discovery is a gated preview: on subscriptions without the
 * preview, ARM rejects the resource type with `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Storage Container
 * **Example:** Blob storage account as a data source
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("science");
 * const account = yield* Azure.Storage.StorageAccount("data", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const container = yield* Azure.Discovery.StorageContainer("data", {
 *   resourceGroup: group.resourceGroupName,
 *   storageStore: {
 *     kind: "AzureStorageBlob",
 *     storageAccountId: account.storageAccountId,
 *   },
 * });
 * ```
 *
 * **Example:** Azure NetApp Files volume
 * ```typescript
 * const container = yield* Azure.Discovery.StorageContainer("hpc", {
 *   resourceGroup: group.resourceGroupName,
 *   storageStore: { kind: "AzureNetAppFiles", netAppVolumeId: volumeId },
 * });
 * ```
 *
 * @resource
 */
export const StorageContainer = Resource<StorageContainer>(
  "Azure.Discovery.StorageContainer",
);

/**
 * Without the Discovery preview ARM rejects the type itself
 * (`InvalidResourceType`): no storage container can exist there.
 */
export const getStorageContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  storageContainerName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetStorageContainer({
      subscriptionId,
      resourceGroupName,
      storageContainerName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const storeResourceId = (store: discovery.StorageStore | undefined) =>
  store?.storageAccountId ?? store?.netAppVolumeId;

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    discovery.GetStorageContainerResponse,
    "id" | "location" | "properties" | "tags"
  >,
): StorageContainer["Attributes"] => ({
  storageContainerName: name,
  storageContainerId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  storeKind: observed.properties?.storageStore.kind ?? "",
  storeResourceId: storeResourceId(observed.properties?.storageStore),
  tags: userTags(observed.tags),
});

const desiredStoreId = (store: StorageContainerStore) =>
  store.kind === "AzureStorageBlob"
    ? store.storageAccountId
    : store.netAppVolumeId;

export const StorageContainerProvider = () =>
  Provider.succeed(StorageContainer, {
    stables: [
      "storageContainerName",
      "storageContainerId",
      "resourceGroup",
      "location",
      "storeKind",
      "storeResourceId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* discovery
        .ListStorageContainerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListStorageContainerBySubscription", page),
          ),
          Effect.catchTag("InvalidResourceType", () =>
            Effect.succeed(undefined),
          ),
        );
      return (page?.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.storageContainerName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        news.storageStore.kind !== output.storeKind ||
        lower(desiredStoreId(news.storageStore)) !==
          lower(output.storeResourceId) ||
        news.storageStore.mountProtocol !== olds?.storageStore?.mountProtocol
      ) {
        // The whole store is create-only.
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.storageContainerName ??
        olds?.name ??
        (yield* createDiscoveryName(id));
      const observed = yield* getStorageContainer(
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
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.storageContainerName ??
        (yield* createDiscoveryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageContainerName: name,
      };
      const get = getStorageContainer(subscriptionId, resourceGroup, name);
      const ready = waitForProvisioned(
        `discovery storage container ${name}`,
        get,
        (container) => container.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The store is create-only.
      if (observed === undefined) {
        yield* discovery.StorageContainersCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { storageStore: { ...news.storageStore } },
        });
      }
      observed = yield* ready;

      // Sync tags (the only mutable aspect).
      if (tagsDiffer(observed.tags, tags)) {
        yield* discovery.UpdateStorageContainer({ ...where, tags });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteStorageContainer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageContainerName: output.storageContainerName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery storage container ${output.storageContainerName}`,
        getStorageContainer(
          subscriptionId,
          output.resourceGroup,
          output.storageContainerName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
