import * as netapp from "@distilled.cloud/azure/netapp";
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
  createNetAppName,
  getVolume,
  LRO_BUDGET,
  ownedByStage,
  whileBusy,
} from "./Common.ts";

export interface SnapshotProps {
  /** Resource group of the NetApp account. Changing it replaces the snapshot. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the snapshot. */
  account: string;
  /** Name of the capacity pool. Changing it replaces the snapshot. */
  pool: string;
  /** Name of the volume to snapshot. Changing it replaces the snapshot. */
  volume: string;
  /**
   * Snapshot name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the snapshot.
   */
  name?: string;
}

export interface Snapshot extends Resource<
  "Azure.NetApp.Snapshot",
  SnapshotProps,
  {
    /** Name of the snapshot. */
    snapshotName: string;
    /** ARM resource ID of the snapshot; pass it as a volume's `snapshotId` to clone. */
    snapshotId: string;
    /** UUID of the snapshot. */
    snapshotUuid: string | undefined;
    /** When the snapshot was taken (ISO 8601). */
    created: string | undefined;
    /** Parent NetApp account. */
    account: string;
    /** Parent capacity pool. */
    pool: string;
    /** Parent volume. */
    volume: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the snapshot. */
    location: string;
  },
  never,
  Providers
> {}

/**
 * A point-in-time Azure NetApp Files snapshot of a volume. Snapshots are
 * immutable: every prop change replaces the snapshot. They are deleted
 * together with their volume.
 *
 * Snapshots have no tags; Alchemy treats a snapshot as owned when its
 * volume carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/azure-netapp-files-manage-snapshots
 *
 * ### Creating a Snapshot
 * **Example:** Snapshot a volume
 * ```typescript
 * const snapshot = yield* Azure.NetApp.Snapshot("before-upgrade", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   volume: volume.volumeName,
 * });
 * ```
 *
 * ### Cloning
 * **Example:** Create a volume from a snapshot
 * ```typescript
 * const clone = yield* Azure.NetApp.Volume("clone", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   subnetId: subnet.subnetId,
 *   snapshotId: snapshot.snapshotId,
 * });
 * ```
 *
 * @resource
 */
export const Snapshot = Resource<Snapshot>("Azure.NetApp.Snapshot");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  accountName: string;
  poolName: string;
  volumeName: string;
  snapshotName: string;
}

const getSnapshot = (where: Where) =>
  orUndefinedIfNotFound(netapp.GetSnapshot(where));

const toAttrs = (
  where: Where,
  snapshot: netapp.GetSnapshotResponse,
): Snapshot["Attributes"] => ({
  snapshotName: where.snapshotName,
  snapshotId: snapshot.id ?? "",
  snapshotUuid: snapshot.properties?.snapshotId,
  created: snapshot.properties?.created,
  account: where.accountName,
  pool: where.poolName,
  volume: where.volumeName,
  resourceGroup: where.resourceGroupName,
  location: snapshot.location ?? "",
});

export const SnapshotProvider = () =>
  Provider.succeed(Snapshot, {
    stables: [
      "snapshotName",
      "snapshotId",
      "snapshotUuid",
      "created",
      "account",
      "pool",
      "volume",
      "resourceGroup",
      "location",
    ],

    // Snapshots are deleted with their volume; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        news.pool.toLowerCase() !== output.pool.toLowerCase() ||
        news.volume.toLowerCase() !== output.volume.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.snapshotName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const accountName = output?.account ?? olds?.account;
      const poolName = output?.pool ?? olds?.pool;
      const volumeName = output?.volume ?? olds?.volume;
      if (!resourceGroupName || !accountName || !poolName || !volumeName) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        accountName,
        poolName,
        volumeName,
        snapshotName:
          output?.snapshotName ??
          olds?.name ??
          (yield* createNetAppName(id, 64)),
      };
      const observed = yield* getSnapshot(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      const parent = yield* getVolume(
        subscriptionId,
        resourceGroupName,
        accountName,
        poolName,
        volumeName,
      );
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        accountName: news.account,
        poolName: news.pool,
        volumeName: news.volume,
        snapshotName:
          news.name ??
          output?.snapshotName ??
          (yield* createNetAppName(id, 64)),
      };
      const get = getSnapshot(where);

      // Observe; ensure (existence-only resource, nothing to sync).
      if ((yield* get) === undefined) {
        const parent = yield* netapp.GetVolume({
          subscriptionId,
          resourceGroupName: where.resourceGroupName,
          accountName: where.accountName,
          poolName: where.poolName,
          volumeName: where.volumeName,
        });
        yield* whileBusy(
          netapp.CreateSnapshot({ ...where, location: parent.location }),
        );
      }
      const observed = yield* waitForProvisioned(
        `netapp snapshot ${where.snapshotName}`,
        get,
        (snapshot) => snapshot.properties?.provisioningState,
        LRO_BUDGET,
      );
      return toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.account,
        poolName: output.pool,
        volumeName: output.volume,
        snapshotName: output.snapshotName,
      };
      yield* whileBusy(ignoreNotFound(netapp.DeleteSnapshot(where)));
      yield* waitUntilGone(
        `netapp snapshot ${output.snapshotName}`,
        getSnapshot(where),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Volume", "Azure.Resources.ResourceGroup"],
    },
  });
