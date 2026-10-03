import * as storagesync from "@distilled.cloud/azure/storagesync";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  isServiceOwnedByStack,
  sameName,
} from "./internal.ts";

export interface SyncGroupProps {
  /**
   * Resource group of the Storage Sync Service. Changing it replaces the
   * sync group.
   */
  resourceGroup: string;
  /**
   * Name of the parent Storage Sync Service. Changing it replaces the sync
   * group.
   */
  storageSyncService: string;
  /**
   * Name of the sync group. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the sync group.
   */
  name?: string;
}

export interface SyncGroup extends Resource<
  "Azure.StorageSync.SyncGroup",
  SyncGroupProps,
  {
    /** Name of the sync group. */
    syncGroupName: string;
    /** ARM resource ID of the sync group. */
    syncGroupId: string;
    /** Name of the parent Storage Sync Service. */
    storageSyncServiceName: string;
    /** Resource group of the Storage Sync Service. */
    resourceGroup: string;
    /** Unique ID of the sync group. */
    uniqueId: string | undefined;
    /** Sync group status reported by Azure. */
    syncGroupStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure File Sync sync group — the sync topology that keeps one cloud
 * endpoint (an Azure file share) and one or more server endpoints (paths on
 * registered Windows servers) in sync. Sync groups are free and have no
 * settings of their own.
 *
 * @see https://learn.microsoft.com/azure/storage/file-sync/file-sync-deployment-guide
 *
 * ### Creating a Sync Group
 * **Example:** Sync group under a Storage Sync Service
 * ```typescript
 * const sync = yield* Azure.StorageSync.StorageSyncService("sync", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const syncGroup = yield* Azure.StorageSync.SyncGroup("docs", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 * });
 * ```
 *
 * @resource
 */
export const SyncGroup = Resource<SyncGroup>("Azure.StorageSync.SyncGroup");

type Observed = storagesync.GetSyncGroupResponse;

const createSyncGroupName = (id: string) => createChildName(id, 60);

export const getSyncGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
  syncGroupName: string,
) =>
  orUndefinedIfNotFound(
    storagesync.GetSyncGroup({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
      syncGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageSyncServiceName: string,
  name: string,
  observed: Observed,
): SyncGroup["Attributes"] => ({
  syncGroupName: name,
  syncGroupId: observed.id ?? "",
  storageSyncServiceName,
  resourceGroup,
  uniqueId: observed.properties?.uniqueId,
  syncGroupStatus: observed.properties?.syncGroupStatus,
});

export const SyncGroupProvider = () =>
  Provider.succeed(SyncGroup, {
    stables: [
      "syncGroupName",
      "syncGroupId",
      "storageSyncServiceName",
      "resourceGroup",
      "uniqueId",
    ],

    // Sync groups disappear with their Storage Sync Service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.storageSyncService, output.storageSyncServiceName) ||
        (news.name !== undefined && !sameName(news.name, output.syncGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const service =
        output?.storageSyncServiceName ?? olds?.storageSyncService;
      if (resourceGroup === undefined || service === undefined) {
        return undefined;
      }
      const name =
        output?.syncGroupName ?? olds?.name ?? (yield* createSyncGroupName(id));
      const observed = yield* getSyncGroup(
        subscriptionId,
        resourceGroup,
        service,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, service, name, observed);
      return (yield* isServiceOwnedByStack(
        subscriptionId,
        resourceGroup,
        service,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageSync");
      const { resourceGroup, storageSyncService } = news;
      const name =
        news.name ?? output?.syncGroupName ?? (yield* createSyncGroupName(id));
      const get = getSyncGroup(
        subscriptionId,
        resourceGroup,
        storageSyncService,
        name,
      );

      // Observe; ensure. A sync group has no mutable settings.
      const observed = yield* get;
      if (observed === undefined) {
        yield* storagesync.CreateSyncGroup({
          subscriptionId,
          resourceGroupName: resourceGroup,
          storageSyncServiceName: storageSyncService,
          syncGroupName: name,
          properties: {},
        });
      }
      const fresh = yield* waitForProvisioned(
        `sync group ${name}`,
        get,
        () => undefined,
      );
      return toAttrs(resourceGroup, storageSyncService, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagesync.DeleteSyncGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageSyncServiceName: output.storageSyncServiceName,
          syncGroupName: output.syncGroupName,
        }),
      );
      yield* waitUntilGone(
        `sync group ${output.syncGroupName}`,
        getSyncGroup(
          subscriptionId,
          output.resourceGroup,
          output.storageSyncServiceName,
          output.syncGroupName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.StorageSync.StorageSyncService",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
