import * as discovery from "@distilled.cloud/azure/discovery";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
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
import { getStorageContainer } from "./StorageContainer.ts";

export interface StorageAssetProps {
  /**
   * Resource group of the parent storage container. Changing it replaces
   * the storage asset.
   */
  resourceGroup: string;
  /** Name of the parent storage container. Changing it replaces the storage asset. */
  storageContainer: string;
  /**
   * Storage asset name: 3-24 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the storage asset.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the storage asset.
   * @default the parent storage container's location
   */
  location?: string;
  /** Description of the data the asset points at. */
  description: string;
  /**
   * Path of the data relative to the root of the parent storage container.
   * Changing it replaces the storage asset.
   */
  path?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageAsset extends Resource<
  "Azure.Discovery.StorageAsset",
  StorageAssetProps,
  {
    /** Name of the storage asset. */
    storageAssetName: string;
    /** ARM resource ID of the storage asset. */
    storageAssetId: string;
    /** Name of the parent storage container. */
    storageContainer: string;
    /** Resource group that holds the storage asset. */
    resourceGroup: string;
    /** Location of the storage asset. */
    location: string;
    /** Path of the data within the storage container. */
    path: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery storage asset
 * (`Microsoft.Discovery/storageContainers/storageAssets`) — a described path
 * of data inside a Discovery storage container.
 *
 * Microsoft Discovery is a gated preview: on subscriptions without the
 * preview, ARM rejects the resource type with `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Storage Asset
 * **Example:** Dataset folder in a storage container
 * ```typescript
 * const asset = yield* Azure.Discovery.StorageAsset("molecules", {
 *   resourceGroup: group.resourceGroupName,
 *   storageContainer: container.storageContainerName,
 *   description: "Candidate molecule library",
 *   path: "datasets/molecules",
 * });
 * ```
 *
 * @resource
 */
export const StorageAsset = Resource<StorageAsset>(
  "Azure.Discovery.StorageAsset",
);

const getStorageAsset = (
  subscriptionId: string,
  resourceGroupName: string,
  storageContainerName: string,
  storageAssetName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetStorageAsset({
      subscriptionId,
      resourceGroupName,
      storageContainerName,
      storageAssetName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  storageContainer: string,
  name: string,
  observed: discovery.GetStorageAssetResponse,
): StorageAsset["Attributes"] => ({
  storageAssetName: name,
  storageAssetId: observed.id ?? "",
  storageContainer,
  resourceGroup,
  location: observed.location,
  path: observed.properties?.path,
  tags: userTags(observed.tags),
});

export const StorageAssetProvider = () =>
  Provider.succeed(StorageAsset, {
    stables: [
      "storageAssetName",
      "storageAssetId",
      "storageContainer",
      "resourceGroup",
      "location",
      "path",
    ],

    // Storage assets live inside a storage container; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.storageContainer) !== lower(output.storageContainer) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.storageAssetName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        (news.path ?? "") !== (output.path ?? "")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageContainer =
        output?.storageContainer ?? olds?.storageContainer;
      if (resourceGroup === undefined || storageContainer === undefined) {
        return undefined;
      }
      const name =
        output?.storageAssetName ??
        olds?.name ??
        (yield* createDiscoveryName(id));
      const observed = yield* getStorageAsset(
        subscriptionId,
        resourceGroup,
        storageContainer,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageContainer, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const { resourceGroup, storageContainer } = news;
      const name =
        news.name ??
        output?.storageAssetName ??
        (yield* createDiscoveryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageContainerName: storageContainer,
        storageAssetName: name,
      };
      const get = getStorageAsset(
        subscriptionId,
        resourceGroup,
        storageContainer,
        name,
      );
      const ready = waitForProvisioned(
        `discovery storage asset ${name}`,
        get,
        (asset) => asset.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getStorageContainer(
            subscriptionId,
            resourceGroup,
            storageContainer,
          ))?.location ??
          env.location;
        yield* discovery.StorageAssetsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { description: news.description, path: news.path },
        });
      }
      observed = yield* ready;

      // Sync description and tags with a PATCH of the deltas.
      const descriptionChanged =
        observed.properties?.description !== news.description;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (descriptionChanged || tagsChanged) {
        yield* discovery.UpdateStorageAsset({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: descriptionChanged
            ? { description: news.description }
            : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, storageContainer, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteStorageAsset({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageContainerName: output.storageContainer,
          storageAssetName: output.storageAssetName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery storage asset ${output.storageAssetName}`,
        getStorageAsset(
          subscriptionId,
          output.resourceGroup,
          output.storageContainer,
          output.storageAssetName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Discovery.StorageContainer",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
