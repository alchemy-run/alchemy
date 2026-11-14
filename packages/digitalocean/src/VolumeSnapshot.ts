import * as DO from "@distilled.cloud/digitalocean";
import type { Snapshots } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import type { Providers } from "./Providers.ts";

export type VolumeSnapshotProps = {
  /** The Volume to snapshot. A change takes a new snapshot. */
  volumeId: string;
  /**
   * Snapshot name. A change takes a new snapshot.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Tags on the snapshot. A change takes a new snapshot. */
  tags?: string[];
};

export type VolumeSnapshot = Resource<
  "DigitalOcean.VolumeSnapshot",
  VolumeSnapshotProps,
  {
    /** Snapshot id; pass it as a Volume's `snapshotId` to restore it. */
    snapshotId: string;
    /** Snapshot name. */
    name: string;
    /** Region the snapshot is in. */
    regions: string[];
    /** Smallest volume, in GiB, it can be restored to. */
    minDiskSize: number;
    /** Size of the snapshot, in GiB. */
    sizeGigabytes: number;
  },
  never,
  Providers
>;

export type VolumeSnapshotAttributes = VolumeSnapshot["Attributes"];

/**
 * A point-in-time snapshot of a block storage Volume, taken when the resource
 * is created. Restore it by creating a Volume from `snapshotId`.
 *
 * ### Taking a Snapshot
 * **Example:** Snapshot a data volume
 * ```typescript
 * const snap = yield* DigitalOcean.VolumeSnapshot("nightly", {
 *   volumeId: data.volumeId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/volumes/how-to/snapshot/
 *
 * @resource
 * @product Volumes
 * @category Storage
 */
export const VolumeSnapshot = Resource<VolumeSnapshot>("DigitalOcean.VolumeSnapshot");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (snapshot: Snapshots): VolumeSnapshotAttributes => ({
  snapshotId: String(snapshot.id),
  name: snapshot.name,
  regions: [...snapshot.regions],
  minDiskSize: snapshot.min_disk_size,
  sizeGigabytes: snapshot.size_gigabytes,
});

const observeById = (snapshotId: string) =>
  noneIfNotFound(
    DO.getVolumeSnapshotById({ snapshot_id: snapshotId }).pipe(Effect.map((r) => r.snapshot)),
  );

const observeByName = (volumeId: string, name: string) =>
  DO.listVolumeSnapshots({ volume_id: volumeId, per_page: 200 }).pipe(
    Effect.map((r) => Option.fromNullishOr((r.snapshots ?? []).find((s) => s.name === name))),
    Effect.catchTag("NotFound", () => Effect.succeedNone),
  );

export const VolumeSnapshotProvider = () =>
  Provider.succeed(VolumeSnapshot, {
    stables: ["snapshotId", "regions", "minDiskSize", "sizeGigabytes"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output !== undefined) {
        const byId = yield* observeById(output.snapshotId);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      const name = olds.name ?? (yield* physicalName(id));
      const named = yield* observeByName(olds.volumeId, name);
      return Option.getOrUndefined(Option.map(named, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.volumeId !== olds.volumeId ||
        news.name !== olds.name ||
        JSON.stringify(news.tags ?? []) !== JSON.stringify(olds.tags ?? [])
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const byId = output === undefined ? Option.none() : yield* observeById(output.snapshotId);
      const existing = Option.isSome(byId) ? byId : yield* observeByName(news.volumeId, name);
      if (Option.isSome(existing)) return toAttrs(existing.value);
      const { snapshot } = yield* DO.createVolumeSnapshot({
        volume_id: news.volumeId,
        name,
        tags: news.tags,
      });
      return toAttrs(snapshot);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteVolumeSnapshotById({ snapshot_id: output.snapshotId }));
    }),
  });
