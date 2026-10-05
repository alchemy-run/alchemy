import * as elasticsan from "@distilled.cloud/azure/elasticsan";
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
import { createSanName, isParentOwned, lower } from "./Common.ts";

export interface SnapshotProps {
  /** Resource group of the Elastic SAN. Changing it replaces the snapshot. */
  resourceGroup: string;
  /** Name of the Elastic SAN. Changing it replaces the snapshot. */
  elasticSan: string;
  /** Name of the volume group. Changing it replaces the snapshot. */
  volumeGroup: string;
  /**
   * Snapshot name: 3-63 lowercase letters, digits, hyphens and underscores,
   * starting and ending with a letter or digit. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the snapshot.
   */
  name?: string;
  /**
   * ARM resource ID of the volume to snapshot (`Volume.volumeResourceId`).
   * The volume must be in the same volume group. Changing it replaces the
   * snapshot.
   */
  sourceVolumeId: string;
}

export interface Snapshot extends Resource<
  "Azure.ElasticSan.Snapshot",
  SnapshotProps,
  {
    /** Name of the snapshot. */
    snapshotName: string;
    /** ARM resource ID of the snapshot (use it as a volume source). */
    snapshotId: string;
    /** Name of the volume group. */
    volumeGroup: string;
    /** Name of the Elastic SAN. */
    elasticSan: string;
    /** Resource group of the Elastic SAN. */
    resourceGroup: string;
    /** ARM resource ID of the source volume. */
    sourceVolumeId: string;
    /** Name of the source volume. */
    volumeName: string | undefined;
    /** Size of the source volume in GiB when the snapshot was taken. */
    sourceVolumeSizeGiB: number | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A point-in-time snapshot of an Azure Elastic SAN volume. Snapshots are
 * immutable: any change replaces the snapshot. Create a new volume from it
 * with `creationData: { createSource: "VolumeSnapshot", sourceId }`.
 *
 * Snapshots have no tags; Alchemy treats a snapshot as owned when its
 * parent SAN carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/storage/elastic-san/elastic-san-snapshots
 *
 * ### Snapshotting a Volume
 * **Example:** Snapshot a volume
 * ```typescript
 * const snapshot = yield* Azure.ElasticSan.Snapshot("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   elasticSan: san.elasticSanName,
 *   volumeGroup: volumes.volumeGroupName,
 *   sourceVolumeId: volume.volumeResourceId,
 * });
 * ```
 *
 * @resource
 */
export const Snapshot = Resource<Snapshot>("Azure.ElasticSan.Snapshot");

type ObservedSnapshot = elasticsan.GetVolumeSnapshotResponse;

const getSnapshot = (
  subscriptionId: string,
  resourceGroupName: string,
  elasticSanName: string,
  volumeGroupName: string,
  snapshotName: string,
) =>
  orUndefinedIfNotFound(
    elasticsan.GetVolumeSnapshot({
      subscriptionId,
      resourceGroupName,
      elasticSanName,
      volumeGroupName,
      snapshotName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  elasticSan: string,
  volumeGroup: string,
  name: string,
  snapshot: ObservedSnapshot,
): Snapshot["Attributes"] => ({
  snapshotName: name,
  snapshotId: snapshot.id ?? "",
  volumeGroup,
  elasticSan,
  resourceGroup,
  sourceVolumeId: snapshot.properties?.creationData?.sourceId ?? "",
  volumeName: snapshot.properties?.volumeName,
  sourceVolumeSizeGiB: snapshot.properties?.sourceVolumeSizeGiB,
  provisioningState: snapshot.properties?.provisioningState,
});

export const SnapshotProvider = () =>
  Provider.succeed(Snapshot, {
    stables: [
      "snapshotName",
      "snapshotId",
      "volumeGroup",
      "elasticSan",
      "resourceGroup",
      "sourceVolumeId",
      "volumeName",
      "sourceVolumeSizeGiB",
    ],

    // Snapshots live inside a volume group; nuke removes them with the SAN.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.elasticSan !== output.elasticSan ||
        news.volumeGroup !== output.volumeGroup ||
        (news.name !== undefined && news.name !== output.snapshotName) ||
        lower(news.sourceVolumeId) !== lower(output.sourceVolumeId)
      ) {
        // An explicit, unchanged name cannot be held by two generations.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && news.name === output.snapshotName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const elasticSan = output?.elasticSan ?? olds?.elasticSan;
      const volumeGroup = output?.volumeGroup ?? olds?.volumeGroup;
      if (
        resourceGroup === undefined ||
        elasticSan === undefined ||
        volumeGroup === undefined
      ) {
        return undefined;
      }
      const name =
        output?.snapshotName ?? olds?.name ?? (yield* createSanName(id, 63));
      const observed = yield* getSnapshot(
        subscriptionId,
        resourceGroup,
        elasticSan,
        volumeGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        elasticSan,
        volumeGroup,
        name,
        observed,
      );
      return (yield* isParentOwned(subscriptionId, resourceGroup, elasticSan))
        ? attrs
        : Unowned(attrs);
    }),

    // Existence-only: snapshots have no mutable properties.
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ElasticSan");
      const { resourceGroup, elasticSan, volumeGroup } = news;
      const name =
        news.name ?? output?.snapshotName ?? (yield* createSanName(id, 63));
      const get = getSnapshot(
        subscriptionId,
        resourceGroup,
        elasticSan,
        volumeGroup,
        name,
      );

      if ((yield* get) === undefined) {
        yield* elasticsan.CreateVolumeSnapshot({
          subscriptionId,
          resourceGroupName: resourceGroup,
          elasticSanName: elasticSan,
          volumeGroupName: volumeGroup,
          snapshotName: name,
          properties: { creationData: { sourceId: news.sourceVolumeId } },
        });
      }
      const observed = yield* waitForProvisioned(
        `elastic san snapshot ${name}`,
        get,
        (snapshot) => snapshot.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, elasticSan, volumeGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elasticsan.DeleteVolumeSnapshot({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          elasticSanName: output.elasticSan,
          volumeGroupName: output.volumeGroup,
          snapshotName: output.snapshotName,
        }),
      );
      yield* waitUntilGone(
        `elastic san snapshot ${output.snapshotName}`,
        getSnapshot(
          subscriptionId,
          output.resourceGroup,
          output.elasticSan,
          output.volumeGroup,
          output.snapshotName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
