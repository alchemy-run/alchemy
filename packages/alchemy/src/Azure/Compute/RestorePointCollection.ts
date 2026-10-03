import * as compute from "@distilled.cloud/azure/compute";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createComputeName,
  sameId,
  waitComputeGone,
  waitComputeProvisioned,
} from "./common.ts";

export interface RestorePointCollectionProps {
  /**
   * Resource group the collection is created in. Changing it replaces the
   * collection.
   */
  resourceGroup: string;
  /**
   * Name of the collection: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the collection.
   */
  name?: string;
  /**
   * Azure location; must match the source VM's. Changing it replaces the
   * collection.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the VM whose restore points the collection holds. Changing
   * it replaces the collection.
   */
  sourceVirtualMachineId: string;
  /**
   * Create restore points with instant access (snapshots usable
   * immediately).
   */
  instantAccess?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface RestorePointCollection extends Resource<
  "Azure.Compute.RestorePointCollection",
  RestorePointCollectionProps,
  {
    /** Name of the collection. */
    restorePointCollectionName: string;
    /** ARM resource ID of the collection. */
    restorePointCollectionResourceId: string;
    /** Unique ID Azure assigned to the collection. */
    restorePointCollectionId: string | undefined;
    /** Resource group that holds the collection. */
    resourceGroup: string;
    /** Location of the collection. */
    location: string;
    /** ARM ID of the source VM. */
    sourceVirtualMachineId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure restore point collection — the container for a VM's restore
 * points (crash- or application-consistent disk snapshots). Deleting the
 * collection deletes all its restore points. The collection is free; each
 * restore point bills its incremental snapshot storage.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/virtual-machines-create-restore-points
 *
 * ### Creating a Collection
 * **Example:** Collection for a VM
 * ```typescript
 * const collection = yield* Azure.Compute.RestorePointCollection("backups", {
 *   resourceGroup: group.resourceGroupName,
 *   sourceVirtualMachineId: vm.virtualMachineId,
 * });
 * ```
 *
 * ### Taking Restore Points
 * **Example:** Crash-consistent restore point
 * ```typescript
 * yield* Azure.Compute.RestorePoint("before-upgrade", {
 *   resourceGroup: group.resourceGroupName,
 *   restorePointCollection: collection.restorePointCollectionName,
 * });
 * ```
 *
 * @resource
 */
export const RestorePointCollection = Resource<RestorePointCollection>(
  "Azure.Compute.RestorePointCollection",
);

type Observed = compute.GetRestorePointCollectionResponse;

const getCollection = (
  subscriptionId: string,
  resourceGroupName: string,
  restorePointCollectionName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetRestorePointCollection({
      subscriptionId,
      resourceGroupName,
      restorePointCollectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  collection: Observed,
): RestorePointCollection["Attributes"] => ({
  restorePointCollectionName: name,
  restorePointCollectionResourceId: collection.id ?? "",
  restorePointCollectionId: collection.properties?.restorePointCollectionId,
  resourceGroup,
  location: collection.location,
  sourceVirtualMachineId: collection.properties?.source?.id,
  tags: userTags(collection.tags),
});

export const RestorePointCollectionProvider = () =>
  Provider.succeed(RestorePointCollection, {
    stables: [
      "restorePointCollectionName",
      "restorePointCollectionResourceId",
      "restorePointCollectionId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListRestorePointCollectionAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRestorePointCollectionAll", page),
          ),
        );
      return page.value.flatMap((collection) => {
        const resourceGroup = resourceGroupOf(collection.id);
        return hasAnyAlchemyTag(collection.tags) &&
          resourceGroup !== undefined &&
          collection.name !== undefined
          ? [toAttrs(resourceGroup, collection.name, collection)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.restorePointCollectionName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameId(news.sourceVirtualMachineId, output.sourceVirtualMachineId)
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
        output?.restorePointCollectionName ??
        olds?.name ??
        (yield* createComputeName(id));
      const observed = yield* getCollection(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.restorePointCollectionName ??
        (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        restorePointCollectionName: name,
      };
      const label = `restore point collection ${name}`;
      const get = getCollection(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* compute.RestorePointCollectionsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            source: { id: news.sourceVirtualMachineId },
            instantAccess: news.instantAccess,
          },
        });
        observed = yield* waitComputeProvisioned(label, get);
      }

      // Sync instant access and tags against observed state.
      const instantChanged =
        news.instantAccess !== undefined &&
        (observed.properties?.instantAccess ?? false) !== news.instantAccess;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (instantChanged || tagsChanged) {
        yield* compute.UpdateRestorePointCollection({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: instantChanged
            ? { instantAccess: news.instantAccess }
            : undefined,
        });
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteRestorePointCollection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          restorePointCollectionName: output.restorePointCollectionName,
        }),
      );
      yield* waitComputeGone(
        `restore point collection ${output.restorePointCollectionName}`,
        getCollection(
          subscriptionId,
          output.resourceGroup,
          output.restorePointCollectionName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
