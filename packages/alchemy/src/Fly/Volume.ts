import { Services } from "@distilled.cloud/fly-io";
import type { Volume as FlyVolume } from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { App, listOwnedApps } from "./App.ts";
import {
  createFlyVolumeName,
  matchesAlchemyPhysicalName,
  sanitizeFlyVolumeName,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

const DEFAULT_REGION = "iad";
const MIN_SIZE_GB = 1;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface VolumeProps {
  /**
   * Parent Fly App. Changing it replaces the Volume.
   */
  app: Ref<App>;
  /**
   * Volume name. Unique per app as a Fly volume group. If omitted, a
   * unique name is generated from the stack, stage and logical ID
   * (ownership stamp). Changing it replaces the Volume.
   */
  name?: string;
  /**
   * Region to create the Volume in (`iad`, `ewr`, `ord`, …).
   * Changing it replaces the Volume.
   *
   * @default "iad"
   */
  region?: string;
  /**
   * Size in GB. Fly minimum is 1. Increasing size updates in place via
   * `volumesExtend`. Fly cannot shrink a Volume — decreasing it replaces.
   */
  sizeGb: number;
  /**
   * Encrypt the Volume at rest. Create-only — changing it replaces.
   */
  encrypted?: boolean;
  /**
   * Filesystem type (`ext4`, …). Create-only — changing it replaces.
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
   * Restore from an existing snapshot. Create-only — changing it replaces.
   */
  snapshotId?: string;
  /**
   * Fork from an existing volume. Create-only — changing it replaces.
   */
  sourceVolumeId?: string;
  /**
   * Require the Volume to land in a unique zone. Create-only — changing
   * it replaces.
   */
  requireUniqueZone?: boolean;
}

export type Volume = Resource<
  "Fly.Volume",
  VolumeProps,
  {
    /** Parent Fly App name. */
    appName: string;
    /** Fly Volume id. */
    volumeId: string;
    /** Volume name (unique per app as a group). */
    name: string;
    /** Region the Volume lives in. */
    region: string;
    /** Size in GB. */
    sizeGb: number;
    /** Whether the Volume is encrypted at rest. */
    encrypted: boolean | undefined;
    /** Filesystem type if the API returned one. */
    fstype: string | undefined;
    /** Observed state (`created`, `hydrating`, …). */
    state: string | undefined;
    /** Machine this Volume is attached to, if any. */
    attachedMachineId: string | undefined;
    /** Whether scheduled automatic snapshots are enabled. */
    autoBackupEnabled: boolean | undefined;
    /** Snapshot retention in days. */
    snapshotRetention: number | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string | undefined;
    /** Availability zone, if the API returned one. */
    zone: string | undefined;
  },
  never,
  Providers
>;

/**
 * An unattached Fly.io Volume under an App. Size can grow in place
 * (`volumesExtend`); Fly cannot shrink. Name, region, encryption and
 * filesystem are immutable (changing any replaces). Attach happens when a
 * Machine or Service reconciles `config.mounts` from `MountVolume` — there
 * is no VolumeAttachment resource.
 *
 * @resource
 * @see https://fly.io/docs/machines/api/volumes-resource/
 *
 * @section Creating a Volume
 * @example Unattached Volume
 * ```typescript
 * const site = yield* Fly.App("Site");
 * const data = yield* Fly.Volume("Data", {
 *   app: site,
 *   sizeGb: 1,
 * });
 * ```
 *
 * @example Encrypted Volume in iad
 * ```typescript
 * const site = yield* Fly.App("Site");
 * const data = yield* Fly.Volume("Data", {
 *   app: site,
 *   region: "iad",
 *   sizeGb: 10,
 *   encrypted: true,
 *   autoBackupEnabled: true,
 *   snapshotRetention: 5,
 * });
 * ```
 *
 * @section Growing a Volume
 * @example Extend in place
 * ```typescript
 * const data = yield* Fly.Volume("Data", {
 *   app: site,
 *   sizeGb: 20,
 * });
 * ```
 */
const resolveVolumeProps = (
  props: VolumeProps | Effect.Effect<VolumeProps, never, Providers>,
): Effect.Effect<VolumeProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const app = Effect.isEffect(resolved.app)
      ? yield* resolved.app as Effect.Effect<App, never, Providers>
      : resolved.app;
    return { ...resolved, app };
  });

const VolumeResource = Resource<Volume>("Fly.Volume");

// Yield Effect-valued `app` at registration so `Volume("Data", { app: Site })`
// works at module scope (Resource does not unwrap nested Effects).
export const Volume: typeof VolumeResource = Object.assign(
  (
    id: string,
    props: VolumeProps | Effect.Effect<VolumeProps, never, Providers>,
  ) => VolumeResource(id, resolveVolumeProps(props)),
  VolumeResource,
);

export class VolumeNotCreated extends Data.TaggedError("Fly.VolumeNotCreated")<{
  name: string;
  appName: string;
}> {}

export class VolumeAppNotResolved extends Data.TaggedError(
  "Fly.VolumeAppNotResolved",
)<{
  message: string;
}> {}

class VolumePending extends Data.TaggedError("Fly.VolumePending")<{
  volumeId: string;
  state: string;
}> {}

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const appNameOf = (value: unknown): string | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const name = (value as { appName?: unknown }).appName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const resolveVolumeName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyVolumeName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyVolumeName(id);
  });

const destroying = (state: string | undefined) =>
  state === "destroyed" ||
  state === "pending_destroy" ||
  state === "scheduled_for_destruction";

const toAttrs = (volume: FlyVolume, appName: string): Volume["Attributes"] => ({
  appName,
  volumeId: volume.id ?? "",
  name: volume.name ?? "",
  region: volume.region ?? "",
  sizeGb: volume.size_gb ?? 0,
  encrypted: volume.encrypted ?? undefined,
  fstype: volume.fstype ?? undefined,
  state: volume.state ?? undefined,
  attachedMachineId: volume.attached_machine_id ?? undefined,
  autoBackupEnabled: volume.auto_backup_enabled ?? undefined,
  snapshotRetention: volume.snapshot_retention ?? undefined,
  createdAt: volume.created_at ?? undefined,
  zone: volume.zone ?? undefined,
});

const getById = (appName: string, volumeId: string) =>
  Services.machines
    .volumesGetById({ app_name: appName, volume_id: volumeId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listByApp = (appName: string) =>
  Services.machines
    .volumesList({ app_name: appName })
    .pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])));

const getByName = (appName: string, name: string, region?: string) =>
  listByApp(appName).pipe(
    Effect.map((volumes) =>
      volumes.find(
        (volume) =>
          volume.name === name &&
          (region === undefined || volume.region === region),
      ),
    ),
  );

const transientState = (state: string | undefined) =>
  state === "creating" || state === "pending" || state === "extending";

const waitUntilReady = (appName: string, volumeId: string) =>
  getById(appName, volumeId).pipe(
    Effect.flatMap((volume) => {
      if (volume === undefined) return Effect.succeed(undefined);
      if (transientState(volume.state)) {
        return Effect.fail(
          new VolumePending({
            volumeId,
            state: volume.state ?? "creating",
          }),
        );
      }
      return Effect.succeed(volume);
    }),
    Effect.retry({
      while: (e) => e._tag === "VolumePending",
      times: 8,
      schedule: backoff,
    }),
    Effect.catchTag("VolumePending", () => getById(appName, volumeId)),
  );

const waitUntilGone = (appName: string, volumeId: string) =>
  getById(appName, volumeId).pipe(
    Effect.map((volume) => volume === undefined || destroying(volume.state)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

const observe = Effect.fn(function* (input: {
  appName?: string;
  volumeId?: string;
  name: string;
  region?: string;
}) {
  if (input.appName !== undefined && input.volumeId !== undefined) {
    const byId = yield* getById(input.appName, input.volumeId);
    if (byId !== undefined) return { volume: byId, appName: input.appName };
  }
  if (input.appName !== undefined) {
    const byName = yield* getByName(input.appName, input.name, input.region);
    if (byName !== undefined) return { volume: byName, appName: input.appName };
  }
  return undefined;
});

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: ["volumeId", "name", "region", "appName"],
    nuke: { dependsOn: ["Fly.Machine", "Fly.Service"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredAppName = appNameOf(news.app);
      const appChanged =
        desiredAppName !== undefined && desiredAppName !== output.appName;
      const desiredName =
        news.name !== undefined
          ? sanitizeFlyVolumeName(news.name)
          : output.name;
      const nameChanged = desiredName !== output.name;
      const desiredRegion = news.region ?? DEFAULT_REGION;
      const regionChanged = desiredRegion !== output.region;
      const encryptedChanged =
        news.encrypted !== undefined &&
        output.encrypted !== undefined &&
        news.encrypted !== output.encrypted;
      const fstypeChanged =
        news.fstype !== undefined &&
        output.fstype !== undefined &&
        news.fstype !== output.fstype;
      const shrink = news.sizeGb < output.sizeGb;
      const snapshotChanged =
        news.snapshotId !== undefined &&
        olds?.snapshotId !== undefined &&
        news.snapshotId !== olds.snapshotId;
      const sourceChanged =
        news.sourceVolumeId !== undefined &&
        olds?.sourceVolumeId !== undefined &&
        news.sourceVolumeId !== olds.sourceVolumeId;
      const uniqueZoneChanged =
        news.requireUniqueZone !== undefined &&
        olds?.requireUniqueZone !== undefined &&
        news.requireUniqueZone !== olds.requireUniqueZone;
      if (
        appChanged ||
        nameChanged ||
        regionChanged ||
        encryptedChanged ||
        fstypeChanged ||
        shrink ||
        snapshotChanged ||
        sourceChanged ||
        uniqueZoneChanged
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const appName = appNameOf(olds?.app) ?? output?.appName;
      const name = yield* resolveVolumeName(id, olds?.name, output?.name);
      const found = yield* observe({
        appName,
        volumeId: output?.volumeId,
        name,
        region: olds?.region ?? output?.region,
      });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found.volume, found.appName);
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.volume.name)
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const apps = yield* listOwnedApps();
      const groups = yield* Effect.forEach(
        apps,
        (app) =>
          listByApp(app.appName).pipe(
            Effect.map((volumes) =>
              volumes
                .filter((volume) => matchesAlchemyPhysicalName(volume.name))
                .map((volume) => toAttrs(volume, app.appName)),
            ),
          ),
        { concurrency: 8 },
      );
      return groups.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news;
      const appName = appNameOf(props.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new VolumeAppNotResolved({
          message: "Fly.Volume requires a resolved App with appName.",
        });
      }
      const name = yield* resolveVolumeName(id, props.name, output?.name);
      const region = props.region ?? output?.region ?? DEFAULT_REGION;
      const sizeGb = Math.max(props.sizeGb, MIN_SIZE_GB);

      // Observe by cached id, then desired name+region. Do not pick a
      // same-name volume in another region — that is a replacement peer.
      let current =
        output?.volumeId !== undefined
          ? yield* getById(output.appName || appName, output.volumeId)
          : undefined;
      if (current === undefined) {
        current = yield* getByName(appName, name, region);
      }

      if (current === undefined) {
        const created = yield* Services.machines
          .volumesCreate({
            app_name: appName,
            name,
            region,
            size_gb: sizeGb,
            encrypted: props.encrypted,
            fstype: props.fstype,
            auto_backup_enabled: props.autoBackupEnabled,
            snapshot_retention: props.snapshotRetention,
            snapshot_id: props.snapshotId,
            source_volume_id: props.sourceVolumeId,
            require_unique_zone: props.requireUniqueZone,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          current =
            (yield* waitUntilReady(appName, created.id ?? "")) ?? created;
        } else {
          const hit = yield* getByName(appName, name, region);
          if (hit === undefined || hit.id === undefined) {
            return yield* new VolumeNotCreated({ name, appName });
          }
          current = (yield* waitUntilReady(appName, hit.id)) ?? hit;
        }
      }

      const volumeId = current.id;
      if (volumeId === undefined || volumeId.length === 0) {
        return yield* new VolumeNotCreated({ name, appName });
      }

      // Sync size — grow only. Shrink is a replacement (handled in diff).
      const observedSize = current.size_gb ?? 0;
      if (sizeGb > observedSize) {
        const extended = yield* Services.machines.volumesExtend({
          app_name: appName,
          volume_id: volumeId,
          size_gb: sizeGb,
        });
        current =
          extended.volume ??
          (yield* waitUntilReady(appName, volumeId)) ??
          current;
      }

      // Sync auto_backup / snapshot_retention against observed cloud state.
      const backupChanged =
        props.autoBackupEnabled !== undefined &&
        props.autoBackupEnabled !== current.auto_backup_enabled;
      const retentionChanged =
        props.snapshotRetention !== undefined &&
        props.snapshotRetention !== current.snapshot_retention;
      if (backupChanged || retentionChanged) {
        current = yield* Services.machines.volumesUpdate({
          app_name: appName,
          volume_id: volumeId,
          auto_backup_enabled: props.autoBackupEnabled,
          snapshot_retention: props.snapshotRetention,
        });
      }

      const fresh = yield* getById(appName, current.id ?? volumeId);
      return toAttrs(fresh ?? current, appName);
    }),

    delete: Effect.fn(function* ({ output }) {
      const appName = output.appName;
      const volumeId = output.volumeId;
      if (appName.length === 0 || volumeId.length === 0) return;
      yield* Services.machines
        .volumeDelete({
          app_name: appName,
          volume_id: volumeId,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 8,
            schedule: backoff,
          }),
        );
      yield* waitUntilGone(appName, volumeId);
    }),
  });
