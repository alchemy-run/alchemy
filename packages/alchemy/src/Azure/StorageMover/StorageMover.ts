import * as storagemover from "@distilled.cloud/azure/storagemover";
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
import { createMoverName, DELETE_BUDGET } from "./Common.ts";

export interface StorageMoverProps {
  /**
   * Resource group the Storage Mover is created in. Changing it replaces
   * the Storage Mover.
   */
  resourceGroup: string;
  /**
   * Name of the Storage Mover: 1-64 letters, digits, `-` and `_`, starting
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the Storage Mover.
   */
  name?: string;
  /**
   * Azure location of the Storage Mover. Changing it replaces the Storage
   * Mover.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the Storage Mover. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageMover extends Resource<
  "Azure.StorageMover.StorageMover",
  StorageMoverProps,
  {
    /** Name of the Storage Mover. */
    storageMoverName: string;
    /** Resource group that holds the Storage Mover. */
    resourceGroup: string;
    /** ARM resource ID of the Storage Mover. */
    storageMoverId: string;
    /** Location of the Storage Mover. */
    location: string;
    /** Description of the Storage Mover. */
    description: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Storage Mover — the top-level resource that holds the projects,
 * endpoints, and job definitions used to migrate files from on-premises
 * shares or other clouds into Azure Storage.
 *
 * @see https://learn.microsoft.com/azure/storage-mover/service-overview
 *
 * ### Creating a Storage Mover
 * **Example:** Storage Mover in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("migration");
 * const mover = yield* Azure.StorageMover.StorageMover("mover", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "File share migration",
 * });
 * ```
 *
 * **Example:** Storage Mover with tags
 * ```typescript
 * const mover = yield* Azure.StorageMover.StorageMover("mover", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "storage" },
 * });
 * ```
 *
 * @resource
 */
export const StorageMover = Resource<StorageMover>(
  "Azure.StorageMover.StorageMover",
);

type ObservedMover = storagemover.GetStorageMoverResponse;

const getMover = (
  subscriptionId: string,
  resourceGroupName: string,
  storageMoverName: string,
) =>
  orUndefinedIfNotFound(
    storagemover.GetStorageMover({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  mover: ObservedMover,
): StorageMover["Attributes"] => ({
  storageMoverName: name,
  resourceGroup,
  storageMoverId: mover.id ?? "",
  location: mover.location,
  description: mover.properties?.description || undefined,
  provisioningState: mover.properties?.provisioningState,
  tags: userTags(mover.tags),
});

export const StorageMoverProvider = () =>
  Provider.succeed(StorageMover, {
    stables: [
      "storageMoverName",
      "resourceGroup",
      "storageMoverId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        storagemover
          .ListStorageMoverBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListStorageMoverBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((mover) => {
        const group = resourceGroupOf(mover.id);
        return hasAnyAlchemyTag(mover.tags) &&
          group !== undefined &&
          mover.name !== undefined
          ? [toAttrs(group, mover.name, mover)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.storageMoverName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase().replaceAll(" ", "") !==
            output.location.toLowerCase().replaceAll(" ", ""))
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
        output?.storageMoverName ?? olds?.name ?? (yield* createMoverName(id));
      const observed = yield* getMover(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageMover");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.storageMoverName ?? (yield* createMoverName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const description = news.description ?? "";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageMoverName: name,
      };
      const get = getMover(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure: the PUT is a synchronous upsert.
      if (observed === undefined) {
        yield* storagemover.StorageMoversCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { description },
        });
      } else if (
        (observed.properties?.description ?? "") !== description ||
        tagsDiffer(observed.tags, tags)
      ) {
        // Sync description and tags against the observed mover.
        yield* storagemover.UpdateStorageMover({
          ...where,
          properties: { description },
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `storage mover ${name}`,
        get,
        (mover) => mover.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagemover.DeleteStorageMover({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageMoverName: output.storageMoverName,
        }),
      );
      yield* waitUntilGone(
        `storage mover ${output.storageMoverName}`,
        getMover(subscriptionId, output.resourceGroup, output.storageMoverName),
        DELETE_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
