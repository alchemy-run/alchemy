import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";

/**
 * Spec for a per-replica Fly disk. Fly Volumes cannot be shared —
 * `count` Machines get `count` Volumes in one name-group.
 */
export interface DiskSpec {
  /**
   * Absolute path inside the Machine the disk is mounted at
   * (e.g. `/data`).
   */
  path: string;
  /**
   * Size in GB. Fly minimum is 1. Increasing size updates in place
   * via `volumesExtend`. Fly cannot shrink a Volume.
   */
  sizeGb: number;
  /**
   * Encrypt the Volume at rest. Create-only.
   */
  encrypted?: boolean;
  /**
   * Filesystem type (`ext4`, …). Create-only.
   */
  fstype?: string;
  /**
   * Enable scheduled automatic snapshots.
   *
   * @default true
   */
  autoBackupEnabled?: boolean;
  /**
   * Snapshot retention in days. Updated in place via `volumesUpdate`.
   */
  snapshotRetention?: number;
  /**
   * Restore from an existing snapshot. Create-only.
   */
  snapshotId?: string;
  /**
   * Fork from an existing volume. Create-only.
   */
  sourceVolumeId?: string;
  /**
   * Require the Volume to land in a unique zone. Create-only.
   */
  requireUniqueZone?: boolean;
  /**
   * Fly volume-group name. If omitted, a unique name is generated
   * from the host's logical ID and {@link path}.
   */
  name?: string;
}

export interface MountVolumeOptions extends DiskSpec {}

/**
 * Runtime view of a disk mounted into a {@link Service}: the path
 * inside the Machine.
 */
export interface MountedVolume {
  /** Mount path inside the Machine (same value as {@link DiskSpec.path}). */
  path: string;
}

/**
 * Observed disk attached to a Machine / Service replica.
 */
export interface MountedDisk {
  /** Mount path inside the Machine. */
  path: string;
  /** Fly Volume id. */
  volumeId: string;
  /** Size in GB. */
  sizeGb: number;
  /** Fly volume-group name. */
  name: string;
}

const isBindHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

/**
 * Binding contract accepted by {@link Service} (and Machine) for mounted
 * disks and injected env.
 */
export interface ServiceBinding {
  env?: Record<string, any>;
  mounts?: DiskSpec[];
}

/**
 * Create a per-replica Fly Volume and mount it into a {@link Service}.
 *
 * There is no standalone Volume resource. From a {@link Machine}, pass
 * `mounts: [{ path, sizeGb }]` instead.
 *
 * @binding
 *
 * @section Mount into a Service
 * Yield `MountVolume` inside init. App and region come from the
 * parent Service. Provide {@link MountVolumeLive}. At runtime you get
 * `disk.path`.
 *
 * A Volume attaches to one Machine. `count: 3` creates three Volumes
 * in one name-group, one per replica.
 *
 * @example Bind a path
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", count: 3, port: 3000 },
 *   Effect.gen(function* () {
 *     const disk = yield* Fly.MountVolume({ path: "/data", sizeGb: 1 });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const text = yield* fs.readFileString(`${disk.path}/hello.txt`);
 *         return HttpServerResponse.text(text);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.MountVolumeLive)),
 * ) {}
 * ```
 *
 * @section Grow a disk
 * `sizeGb` can grow in place via `volumesExtend`. Fly cannot shrink a
 * Volume. Minimum size is 1 GB.
 *
 * @example 10 GB
 * ```typescript
 * const disk = yield* Fly.MountVolume({ path: "/data", sizeGb: 10 });
 * ```
 *
 * @section Encryption
 * `encrypted` encrypts the Volume at rest.
 *
 * @example Encrypted
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   encrypted: true,
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `encrypted` later is ignored.
 * :::
 *
 * @section Filesystem
 * `fstype` is the filesystem (`ext4`, …).
 *
 * @example ext4
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   fstype: "ext4",
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `fstype` later is ignored.
 * :::
 *
 * @section Scheduled snapshots
 * Scheduled snapshots default on (`autoBackupEnabled`).
 * `snapshotRetention` is days and updates in place. An on-demand
 * snapshot is {@link VolumeSnapshot}.
 *
 * @example Retention
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   autoBackupEnabled: true,
 *   snapshotRetention: 5,
 * });
 * ```
 *
 * @section Restore from a snapshot
 * `snapshotId` restores into a new disk.
 *
 * @example snapshotId
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   snapshotId: Nightly.snapshotId,
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `snapshotId` later is ignored.
 * :::
 *
 * @section Fork a volume
 * `sourceVolumeId` forks from an existing Volume.
 *
 * @example sourceVolumeId
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   sourceVolumeId: box.mounts[0].volumeId,
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `sourceVolumeId` later is ignored.
 * :::
 *
 * @section Unique zone
 * `requireUniqueZone` asks Fly to land the Volume in a unique zone.
 *
 * @example Unique zone
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   requireUniqueZone: true,
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `requireUniqueZone` later is ignored.
 * :::
 *
 * @section Volume name
 * `name` is the Fly volume-group name. If omitted, a unique name is
 * generated from the host's logical ID and `path`.
 *
 * @example Named group
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   name: "api_data",
 * });
 * ```
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "Fly.MountVolume",
  (options: MountVolumeOptions) => Effect.Effect<MountedVolume>
> {}

export const MountVolume = Binding.Service<MountVolume>("Fly.MountVolume");

export const MountVolumeLive = Layer.effect(
  MountVolume,
  Effect.succeed(
    Effect.fn(function* (options: MountVolumeOptions) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindHost(host)) {
          yield* host.bind`Fly.MountVolume(${options.path})`({
            mounts: [options],
          });
        }
      }
      return { path: options.path };
    }),
  ),
);
