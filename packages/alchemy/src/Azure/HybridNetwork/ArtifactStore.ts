import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
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
  createHybridNetworkName,
  NAMESPACE,
  sameArm,
  STORE_BUDGET,
  retryInProgress,
} from "./Common.ts";

export type ArtifactStoreType =
  | "AzureContainerRegistry"
  | "AzureStorageAccount";

export interface ArtifactStoreManagedResourceGroup {
  /** Name of the managed resource group AOSM creates for the backing store. */
  name?: string;
  /** Location of the managed resource group. */
  location?: string;
}

export interface ArtifactStoreProps {
  /** Resource group of the publisher. Changing it replaces the store. */
  resourceGroup: string;
  /** Name of the publisher that owns the store. Changing it replaces the store. */
  publisher: string;
  /**
   * Store name: 1-64 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the store.
   */
  name?: string;
  /**
   * Azure location; must match the publisher's location. Changing it
   * replaces the store.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Backing store: an Azure Container Registry (Helm charts, container
   * images, ARM templates) or a storage account (VHD images). Changing it
   * replaces the store.
   * @default "AzureContainerRegistry"
   */
  storeType?: ArtifactStoreType;
  /**
   * Replication strategy of the backing store. Changing it replaces the
   * store.
   * @default "SingleReplication"
   */
  replicationStrategy?: "SingleReplication";
  /**
   * Managed resource group AOSM creates to hold the backing registry or
   * storage account. AOSM picks a name when omitted. Changing it replaces
   * the store.
   */
  managedResourceGroupConfiguration?: ArtifactStoreManagedResourceGroup;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ArtifactStore extends Resource<
  "Azure.HybridNetwork.ArtifactStore",
  ArtifactStoreProps,
  {
    /** Name of the store. */
    artifactStoreName: string;
    /** ARM resource ID of the store. */
    artifactStoreId: string;
    /** Name of the publisher that owns the store. */
    publisher: string;
    /** Resource group of the publisher. */
    resourceGroup: string;
    /** Location of the store. */
    location: string;
    /** Backing store type. */
    storeType: string;
    /** Replication strategy of the backing store. */
    replicationStrategy: string | undefined;
    /** Name of the managed resource group holding the backing store. */
    managedResourceGroup: string | undefined;
    /** ARM ID of the backing container registry or storage account. */
    storageResourceId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager artifact store — a publisher-scoped
 * store for network function artifacts (Helm charts, container images,
 * ARM templates, VHDs). AOSM provisions a managed resource group holding
 * an Azure Container Registry or a storage account behind it.
 *
 * The backing container registry is billed (Standard tier, about
 * $0.17/day); creation and deletion take several minutes.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/artifact-store-overview
 *
 * ### Creating a Store
 * **Example:** Container registry artifact store
 * ```typescript
 * const store = yield* Azure.HybridNetwork.ArtifactStore("store", {
 *   resourceGroup: group.resourceGroupName,
 *   publisher: publisher.publisherName,
 * });
 * ```
 *
 * **Example:** Storage account store for VHD images
 * ```typescript
 * const store = yield* Azure.HybridNetwork.ArtifactStore("vhds", {
 *   resourceGroup: group.resourceGroupName,
 *   publisher: publisher.publisherName,
 *   storeType: "AzureStorageAccount",
 *   managedResourceGroupConfiguration: {
 *     name: "aosm-vhd-store",
 *     location: "eastus",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ArtifactStore = Resource<ArtifactStore>(
  "Azure.HybridNetwork.ArtifactStore",
);

const getStore = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
  artifactStoreName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetArtifactStore({
      subscriptionId,
      resourceGroupName,
      publisherName,
      artifactStoreName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  publisher: string,
  name: string,
  store: hybridnetwork.GetArtifactStoreResponse | hybridnetwork.ArtifactStore,
): ArtifactStore["Attributes"] => ({
  artifactStoreName: name,
  artifactStoreId: store.id ?? "",
  publisher,
  resourceGroup,
  location: store.location,
  storeType: store.properties?.storeType ?? "AzureContainerRegistry",
  replicationStrategy: store.properties?.replicationStrategy,
  managedResourceGroup:
    store.properties?.managedResourceGroupConfiguration?.name,
  storageResourceId: store.properties?.storageResourceId,
  tags: userTags(store.tags),
});

export const ArtifactStoreProvider = () =>
  Provider.succeed(ArtifactStore, {
    stables: [
      "artifactStoreName",
      "artifactStoreId",
      "publisher",
      "resourceGroup",
      "location",
      "storeType",
      "replicationStrategy",
      "managedResourceGroup",
      "storageResourceId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const publishers = yield* hybridnetwork
        .ListPublisherBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPublisherBySubscription", page),
          ),
        );
      const found: ArtifactStore["Attributes"][] = [];
      for (const publisher of publishers.value ?? []) {
        const group = resourceGroupOf(publisher.id);
        if (group === undefined || publisher.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          hybridnetwork.ListArtifactStoreByPublisher({
            subscriptionId,
            resourceGroupName: group,
            publisherName: publisher.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListArtifactStoreByPublisher", page);
        }
        for (const store of page?.value ?? []) {
          if (hasAnyAlchemyTag(store.tags) && store.name !== undefined) {
            found.push(toAttrs(group, publisher.name, store.name, store));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const mrg = news.managedResourceGroupConfiguration?.name;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.publisher, output.publisher) ||
        (news.name !== undefined && news.name !== output.artifactStoreName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (news.storeType ?? "AzureContainerRegistry") !== output.storeType ||
        (mrg !== undefined && !sameArm(mrg, output.managedResourceGroup))
      ) {
        // A pinned managed resource group can only be reused once the old
        // store (and its managed group) is gone.
        return {
          action: "replace",
          deleteFirst:
            mrg !== undefined && sameArm(mrg, output.managedResourceGroup),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const publisher = output?.publisher ?? olds?.publisher;
      if (resourceGroup === undefined || publisher === undefined) {
        return undefined;
      }
      const name =
        output?.artifactStoreName ??
        olds?.name ??
        (yield* createHybridNetworkName(id));
      const observed = yield* getStore(
        subscriptionId,
        resourceGroup,
        publisher,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, publisher, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, publisher } = news;
      const name =
        news.name ??
        output?.artifactStoreName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: publisher,
        artifactStoreName: name,
      };
      const get = getStore(subscriptionId, resourceGroup, publisher, name);
      const label = `AOSM artifact store ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation provisions a managed registry (several minutes).
      if (observed === undefined) {
        yield* retryInProgress(
          hybridnetwork.ArtifactStoresCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              storeType: news.storeType ?? "AzureContainerRegistry",
              replicationStrategy:
                news.replicationStrategy ?? "SingleReplication",
              managedResourceGroupConfiguration:
                news.managedResourceGroupConfiguration,
            },
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (store) => store.properties?.provisioningState,
        STORE_BUDGET,
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateArtifactStore({ ...where, tags }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (store) =>
            tagsDiffer(store.tags, tags)
              ? "Updating"
              : store.properties?.provisioningState,
          STORE_BUDGET,
        );
      }

      return toAttrs(resourceGroup, publisher, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeleteArtifactStore({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            publisherName: output.publisher,
            artifactStoreName: output.artifactStoreName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM artifact store ${output.artifactStoreName}`,
        getStore(
          subscriptionId,
          output.resourceGroup,
          output.publisher,
          output.artifactStoreName,
        ),
        STORE_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridNetwork.Publisher",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
