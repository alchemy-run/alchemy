import * as hci from "@distilled.cloud/azure/azurestackhci";
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
import {
  HCI_NAMESPACE,
  type HciExtendedLocation,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

export interface StorageContainerProps {
  /** Resource group the storage container is created in. Changing it replaces the storage container. */
  resourceGroup: string;
  /**
   * Name of the storage container. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the storage container.
   */
  name?: string;
  /**
   * Azure region of the storage container; must match the custom location's region.
   * Changing it replaces the storage container.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the storage container.
   * Changing it replaces the storage container.
   */
  extendedLocation: HciExtendedLocation;
  /**
   * Cluster shared volume path that holds VM images and disks, e.g.
   * `C:\\ClusterStorage\\UserStorage_1\\images`. Changing it replaces the
   * container.
   */
  path: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageContainer extends Resource<
  "Azure.AzureStackHCI.StorageContainer",
  StorageContainerProps,
  {
    /** Name of the storage container. */
    storageContainerName: string;
    /** Resource group that holds the storage container. */
    resourceGroup: string;
    /** ARM resource ID of the storage container. */
    storageContainerId: string;
    /** Azure region of the storage container. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the storage container. */
    customLocationId: string | undefined;
    /** Provisioning state of the storage container. */
    provisioningState: string | undefined;
    /** Cluster shared volume path of the container. */
    path: string | undefined;
    /** Available space on the volume, in MB. */
    availableSizeMB: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A storage path on an Azure Local cluster's shared volumes where Arc VM
 * images and virtual hard disks are stored. Needs an Arc custom location
 * backed by the Arc Resource Bridge of a deployed Azure Local cluster.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/create-storage-path
 *
 * ### Creating a Storage Path
 * **Example:** Storage path on a cluster shared volume
 * ```typescript
 * const storage = yield* Azure.AzureStackHCI.StorageContainer("images", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   path: "C:\\ClusterStorage\\UserStorage_1\\images",
 * });
 * ```
 *
 * @resource
 */
export const StorageContainer = Resource<StorageContainer>(
  "Azure.AzureStackHCI.StorageContainer",
);

const SPEC_KEYS = ["path"] as const;

const getStorageContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  storageContainerName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetStorageContainer({
      subscriptionId,
      resourceGroupName,
      storageContainerName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: hci.GetStorageContainerResponse,
): StorageContainer["Attributes"] => ({
  storageContainerName: name,
  resourceGroup,
  storageContainerId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  provisioningState: value.properties?.provisioningState,
  path: value.properties?.path,
  availableSizeMB: value.properties?.status?.availableSizeMB,
  tags: userTags(value.tags),
});

export const StorageContainerProvider = () =>
  Provider.succeed(StorageContainer, {
    stables: [
      "storageContainerName",
      "resourceGroup",
      "storageContainerId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        hci
          .ListStorageContainerAll({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListStorageContainerAll", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) &&
          group !== undefined &&
          value.name !== undefined
          ? [toAttrs(group, value.name, value)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.storageContainerName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined &&
          SPEC_KEYS.some((key) => !sameValue(news[key], olds[key])))
      ) {
        // An explicit name is reused by the replacement, so the old one
        // must go first; generated names differ per instance.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.storageContainerName ?? olds?.name ?? (yield* createName(id));
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
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.storageContainerName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageContainerName: name,
      };
      const get = getStorageContainer(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `Azure Local storage container ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Everything but tags is immutable (diff replaces), so the
      // PUT only runs when the storage container is missing.
      if (observed === undefined) {
        yield* hci.StorageContainersCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            path: news.path,
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed storage container.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hci.UpdateStorageContainer({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteStorageContainer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageContainerName: output.storageContainerName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local storage container ${output.storageContainerName}`,
        getStorageContainer(
          subscriptionId,
          output.resourceGroup,
          output.storageContainerName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
