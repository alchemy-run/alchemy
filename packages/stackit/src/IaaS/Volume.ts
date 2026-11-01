import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, labelsChanged, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findOwnedByName,
  iaasName,
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/** The create response of a volume carried no id. */
export class VolumeIdMissing extends Data.TaggedError("Stackit.IaaS.VolumeIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** Where a volume's initial content comes from. */
export interface VolumeSource {
  /** Kind of source. */
  type: "image" | "volume" | "snapshot" | "backup";
  /** Id of the image, volume, snapshot or backup. */
  id: string;
}

/**
 * STACKIT KMS key that encrypts the volume. These parameters are write-only:
 * STACKIT never returns them, so a change is detected against the previous
 * props only.
 */
export interface VolumeEncryption {
  /** UUID of the key in STACKIT KMS. */
  kekKeyId: string;
  /** Version of the KMS key. */
  kekKeyVersion: number;
  /** UUID of the KMS key ring holding the key. */
  kekKeyringId: string;
  /** Service account linked to the KMS key. */
  serviceAccount: string;
}

export interface VolumeProps extends ProjectScopedProps {
  /**
   * Name of the volume. Updated in place.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /** Free-text description. Updated in place; unmanaged when omitted. */
  description?: string;
  /**
   * Availability zone, e.g. `eu01-1`, `eu01-2`, `eu01-3` or the metro zone
   * `eu01-m`. A volume can only attach to a server in the same zone.
   * Changing it replaces the volume.
   * @default `<region>-1`
   */
  availabilityZone?: string;
  /**
   * Size in GB. Growing it resizes the volume in place; shrinking it
   * replaces the volume (STACKIT cannot shrink a volume). Required unless
   * `source` sets the size.
   */
  size?: number;
  /**
   * Performance class, e.g. `storage_premium_perf1`. List the classes of a
   * region with `listVolumePerformanceClasses`. Changing it replaces the
   * volume.
   * @default the region's default class
   */
  performanceClass?: string;
  /** Initial content of the volume. Changing it replaces the volume. */
  source?: VolumeSource;
  /**
   * Encrypt the volume with a customer-managed STACKIT KMS key. Changing it
   * replaces the volume.
   */
  encryption?: VolumeEncryption;
  /**
   * Whether the volume can boot a server. Updated in place; unmanaged when
   * omitted.
   */
  bootable?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface VolumeAttributes {
  /** Volume id (UUID). */
  volumeId: string;
  /** Name of the volume. */
  name: string;
  /** Project of the volume. */
  projectId: string;
  /** Region of the volume. */
  region: string;
  /** Availability zone of the volume. */
  availabilityZone: string;
  /** Size in GB. */
  size: number | undefined;
  /** Performance class. */
  performanceClass: string | undefined;
  /** Description. */
  description: string | undefined;
  /** Whether the volume can boot a server. */
  bootable: boolean;
  /** Whether the volume is encrypted. */
  encrypted: boolean;
  /** Initial content of the volume (`type` and `id`), if any. */
  source: { type: string; id: string } | undefined;
  /** Server the volume is attached to, if any. */
  serverId: string | undefined;
  /** Status, e.g. `AVAILABLE` or `ATTACHED`. */
  status: string | undefined;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Volume = Resource<
  "Stackit.IaaS.Volume",
  VolumeProps,
  VolumeAttributes,
  never,
  Providers
>;

/**
 * A STACKIT block storage volume. Attach it to a server with
 * `Stackit.IaaS.VolumeAttachment`, snapshot it with
 * `Stackit.IaaS.Snapshot`, or back it up with `Stackit.IaaS.Backup`.
 *
 * Name, description, bootable flag and labels update in place, and a larger
 * `size` grows the volume in place. Volumes are billed per GB-hour by
 * performance class.
 *
 * ### Creating a volume
 * **Example:** An empty data volume
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const data = yield* Stackit.IaaS.Volume("Data", {
 *   size: 20,
 *   availabilityZone: "eu01-1",
 *   labels: { purpose: "data" },
 * });
 * ```
 *
 * **Example:** A volume restored from a snapshot
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const source = yield* Stackit.IaaS.Volume("Source", { size: 10 });
 * const snapshot = yield* Stackit.IaaS.Snapshot("Nightly", {
 *   volumeId: source.volumeId,
 * });
 * const restored = yield* Stackit.IaaS.Volume("Restored", {
 *   source: { type: "snapshot", id: snapshot.snapshotId },
 *   size: 10,
 * });
 * ```
 *
 * ### Growing a volume
 * **Example:** Resize in place
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // was `size: 20`; the next deploy grows the volume to 50 GB
 * const data = yield* Stackit.IaaS.Volume("Data", { size: 50 });
 * ```
 *
 * ### Encryption
 * **Example:** A volume encrypted with a KMS key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const secure = yield* Stackit.IaaS.Volume("Secure", {
 *   size: 20,
 *   encryption: {
 *     kekKeyringId: "<keyring id>",
 *     kekKeyId: "<key id>",
 *     kekKeyVersion: 1,
 *     serviceAccount: "kms-user@sa.stackit.cloud",
 *   },
 * });
 * ```
 *
 * ### Replacement
 * Changing `availabilityZone`, `performanceClass`, `source`, `encryption`,
 * `projectId` or `region`, or shrinking `size`, creates a new volume and
 * deletes the old one, **with its data**. Snapshot or back up the volume
 * first.
 *
 * @resource
 * @product STACKIT Block Storage
 * @category IaaS
 */
export const Volume = Resource<Volume>("Stackit.IaaS.Volume");

const READY_TIMEOUT = "10 minutes";

/** Settled states; `ATTACHED` covers a volume in use by a server. */
const isReady = (volume: iaas.Volume) =>
  volume.status === "AVAILABLE" || volume.status === "ATTACHED";

const hasFailed = (volume: iaas.Volume) =>
  volume.status === "ERROR" || volume.status === "ERROR_RESIZING" ? volume.status : undefined;

const availabilityZoneOf = (news: VolumeProps, region: string) =>
  news.availabilityZone ?? `${region}-1`;

const toSource = (source: iaas.BackupSource | undefined) =>
  source === undefined ? undefined : { type: source.type, id: source.id };

const toAttrs = (volume: iaas.Volume, scope: ProjectScope, name: string): VolumeAttributes => ({
  volumeId: volume.id ?? "",
  name: volume.name ?? name,
  ...scope,
  availabilityZone: volume.availabilityZone,
  size: volume.size,
  performanceClass: volume.performanceClass,
  description: volume.description,
  bootable: volume.bootable ?? false,
  encrypted: volume.encrypted ?? false,
  source: toSource(volume.source),
  serverId: volume.serverId,
  status: volume.status,
  labels: stripInternalLabels(volume.labels),
});

const getVolume = (scope: ProjectScope, volumeId: string) =>
  iaas.getVolume({ ...scope, volumeId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** A listed volume can take the desired props in place. */
const compatible = (news: VolumeProps, region: string) => (volume: iaas.Volume) =>
  volume.availabilityZone === availabilityZoneOf(news, region) &&
  (news.performanceClass === undefined || volume.performanceClass === news.performanceClass) &&
  (news.size === undefined || (volume.size ?? 0) <= news.size);

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  scope: ProjectScope;
  volumeId: string | undefined;
  news: VolumeProps | undefined;
}) {
  if (args.volumeId !== undefined) {
    const byId = yield* getVolume(args.scope, args.volumeId);
    if (byId !== undefined) return byId;
  }
  // Crash recovery: a create whose state was never persisted.
  const { items } = yield* iaas.listVolumes(args.scope);
  return yield* findOwnedByName(
    args.id,
    args.name,
    items,
    args.news === undefined ? undefined : compatible(args.news, args.scope.region),
  );
});

const sourceKey = (source: VolumeSource | undefined) =>
  source === undefined ? "" : `${source.type}:${source.id}`;

const encryptionKey = (encryption: VolumeEncryption | undefined) =>
  encryption === undefined
    ? ""
    : `${encryption.kekKeyringId}/${encryption.kekKeyId}@${encryption.kekKeyVersion}/${encryption.serviceAccount}`;

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: ["volumeId", "projectId", "region", "availabilityZone"],
    nuke: { dependsOn: ["Stackit.IaaS.Server"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listVolumes(scope);
      return ownedOnly(items).map((volume) => toAttrs(volume, scope, volume.name ?? ""));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      if (availabilityZoneOf(news, output.region) !== output.availabilityZone) {
        return { action: "replace" } as const;
      }
      if (
        news.performanceClass !== undefined &&
        output.performanceClass !== undefined &&
        news.performanceClass !== output.performanceClass
      ) {
        return { action: "replace" } as const;
      }
      // Shrinking replaces. Compare against the previously desired size, so
      // a volume grown out of band is never replaced (and its data lost).
      const previousSize = olds?.size ?? output.size;
      if (news.size !== undefined && previousSize !== undefined && news.size < previousSize) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        if (sourceKey(news.source) !== sourceKey(olds.source)) {
          return { action: "replace" } as const;
        }
        if (encryptionKey(news.encryption) !== encryptionKey(olds.encryption)) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe({ id, name, scope, volumeId: output?.volumeId, news: olds });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope, name);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredLabels(id, news.labels);
      const resource = `STACKIT volume ${name}`;

      // Observe — `output.volumeId` is a cache; fall back to ownership
      // labels + name for a create whose state was never persisted.
      let current = yield* observe({ id, name, scope, volumeId: output?.volumeId, news });

      // Ensure — create when missing.
      if (current === undefined) {
        current = yield* iaas.createVolume({
          ...scope,
          name,
          description: news.description,
          availabilityZone: availabilityZoneOf(news, scope.region),
          size: news.size,
          performanceClass: news.performanceClass,
          source: news.source,
          encryptionParameters: news.encryption,
          bootable: news.bootable,
          labels,
        });
      }
      const volumeId = current.id;
      if (volumeId === undefined) {
        return yield* new VolumeIdMissing({
          resourceName: name,
          message: `STACKIT returned volume ${name} without an id`,
        });
      }
      const read = iaas.getVolume({ ...scope, volumeId });
      const settle = (extra: (volume: iaas.Volume) => boolean = () => true) =>
        waitFor({
          resource,
          read,
          ready: (volume) => isReady(volume) && extra(volume),
          failed: hasFailed,
          state: (volume) => volume.status,
          timeout: READY_TIMEOUT,
        });
      let observed = isReady(current) ? current : yield* settle();

      // Sync size — grow only (a shrink is a replacement, decided in diff).
      if (news.size !== undefined && (observed.size ?? 0) < news.size) {
        const size = news.size;
        yield* iaas.resizeVolume({ ...scope, volumeId, size }).pipe(Effect.retry(conflictRetry));
        observed = yield* settle((volume) => (volume.size ?? 0) >= size);
      }

      // Sync name, description, bootable flag and labels in one update.
      const patch: Omit<iaas.UpdateVolumeRequest, "projectId" | "region" | "volumeId"> = {};
      if (observed.name !== name) patch.name = name;
      if (news.description !== undefined && observed.description !== news.description) {
        patch.description = news.description;
      }
      if (news.bootable !== undefined && (observed.bootable ?? false) !== news.bootable) {
        patch.bootable = news.bootable;
      }
      const labelPatch = labelsPatch(observed.labels, labels);
      if (labelPatch !== undefined) patch.labels = labelPatch;
      if (Object.keys(patch).length > 0) {
        observed = yield* iaas.updateVolume({ ...scope, volumeId, ...patch });
        if (!isReady(observed) || labelsChanged(observed.labels, labels)) {
          observed = yield* settle((volume) => !labelsChanged(volume.labels, labels));
        }
      }

      return toAttrs({ ...observed, id: volumeId }, scope, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      // `Conflict` while the volume is still detaching from a server.
      yield* iaas.deleteVolume({ ...scope, volumeId: output.volumeId }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT volume ${output.name}`,
        read: getVolume(scope, output.volumeId),
        state: (volume) => volume.status,
        timeout: "5 minutes",
      });
    }),
  });
