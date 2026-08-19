import { Services } from "@distilled.cloud/fly-io";
import type {
  Volume as FlyVolume,
  VolumeSnapshot as FlyVolumeSnapshot,
} from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listOwnedApps } from "./App.ts";
import type { App } from "./App.ts";
import { matchesAlchemyPhysicalName } from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import type { Volume } from "./Volume.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface VolumeSnapshotProps {
  /**
   * Parent Fly App. Changing it replaces the snapshot (a new snapshot is
   * created on the new App's Volume). There is no delete API for the old
   * snapshot — it follows Volume `snapshot_retention`.
   */
  app: Ref<App>;
  /**
   * Volume to snapshot. Changing it replaces the snapshot. Identity is
   * the snapshot `id` returned by a subsequent `volumesListSnapshots`.
   */
  volume: Ref<Volume>;
}

export type VolumeSnapshot = Resource<
  "Fly.VolumeSnapshot",
  VolumeSnapshotProps,
  {
    /** Parent Fly App name. */
    appName: string;
    /** Fly Volume id this snapshot belongs to. */
    volumeId: string;
    /** Fly snapshot id (`vs_…`). Identity of the resource. */
    snapshotId: string;
    /** Observed snapshot status, if the API returned one. */
    status: string | undefined;
    /** Content digest of the snapshot. */
    digest: string | undefined;
    /** Snapshot size in bytes, if the API returned one. */
    size: number | undefined;
    /** Source volume size in GB at snapshot time. */
    volumeSize: number | undefined;
    /** Retention in days. */
    retentionDays: number | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An on-demand snapshot of a Fly.io Volume.
 *
 * Create is fire-and-forget (`createVolumeSnapshot`); identity is the
 * snapshot `id` from a subsequent `volumesListSnapshots`. There is no
 * delete API and no mutable props — `app` and `volume` replace. Destroy
 * is a no-op; snapshots follow Volume `snapshot_retention` / Volume
 * delete. `nuke` skips this type.
 *
 * @resource
 * @see https://fly.io/docs/machines/api/volumes-resource/
 *
 * @section Creating a Snapshot
 * @example Snapshot a Volume
 * ```typescript
 * const site = yield* Fly.App("Site");
 * const data = yield* Fly.Volume("Data", {
 *   app: site,
 *   sizeGb: 1,
 * });
 * const snap = yield* Fly.VolumeSnapshot("Nightly", {
 *   app: site,
 *   volume: data,
 * });
 * ```
 */
export const VolumeSnapshot = Resource<VolumeSnapshot>("Fly.VolumeSnapshot");

export class VolumeSnapshotNotCreated extends Data.TaggedError(
  "Fly.VolumeSnapshotNotCreated",
)<{
  appName: string;
  volumeId: string;
}> {}

export class VolumeSnapshotRefsMissing extends Data.TaggedError(
  "Fly.VolumeSnapshotRefsMissing",
)<{
  message: string;
}> {}

class VolumeSnapshotPending extends Data.TaggedError(
  "Fly.VolumeSnapshotPending",
)<{
  volumeId: string;
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

const volumeIdOf = (value: unknown): string | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const id = (value as { volumeId?: unknown }).volumeId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

const toAttrs = (
  appName: string,
  volumeId: string,
  snapshot: FlyVolumeSnapshot,
): VolumeSnapshot["Attributes"] => ({
  appName,
  volumeId,
  snapshotId: snapshot.id ?? "",
  status: snapshot.status,
  digest: snapshot.digest,
  size: snapshot.size,
  volumeSize: snapshot.volume_size,
  retentionDays: snapshot.retention_days,
  createdAt: snapshot.created_at,
});

const listSnapshots = (appName: string, volumeId: string) =>
  Services.machines
    .volumesListSnapshots({
      app_name: appName,
      volume_id: volumeId,
    })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as FlyVolumeSnapshot[]),
      ),
    );

const findById = (appName: string, volumeId: string, snapshotId: string) =>
  listSnapshots(appName, volumeId).pipe(
    Effect.map((snapshots) =>
      snapshots.find((snapshot) => snapshot.id === snapshotId),
    ),
  );

const newestFirst = (left: FlyVolumeSnapshot, right: FlyVolumeSnapshot) =>
  Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "");

const pickNewest = (
  snapshots: FlyVolumeSnapshot[],
): FlyVolumeSnapshot | undefined =>
  snapshots
    .filter((snapshot) => (snapshot.id ?? "").length > 0)
    .sort(newestFirst)[0];

const waitForNewSnapshot = (
  appName: string,
  volumeId: string,
  knownIds: ReadonlySet<string>,
) =>
  listSnapshots(appName, volumeId).pipe(
    Effect.flatMap((snapshots) => {
      const next = pickNewest(
        snapshots.filter(
          (snapshot) => snapshot.id !== undefined && !knownIds.has(snapshot.id),
        ),
      );
      if (next !== undefined) return Effect.succeed(next);
      return Effect.fail(new VolumeSnapshotPending({ volumeId }));
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.VolumeSnapshotPending",
      times: 8,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.VolumeSnapshotPending", () =>
      Effect.succeed(undefined),
    ),
  );

const listOwnedVolumes = Effect.fn(function* () {
  const apps = yield* listOwnedApps();
  const groups = yield* Effect.forEach(
    apps,
    (app) =>
      Services.machines.volumesList({ app_name: app.appName }).pipe(
        Effect.map((volumes) =>
          volumes.flatMap((volume) => {
            if (!matchesAlchemyPhysicalName(volume.name)) return [];
            const volumeId = volume.id;
            if (volumeId === undefined || volumeId.length === 0) return [];
            return [{ appName: app.appName, volumeId, volume }];
          }),
        ),
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          Effect.succeed(
            [] as Array<{
              appName: string;
              volumeId: string;
              volume: FlyVolume;
            }>,
          ),
        ),
      ),
    { concurrency: 8 },
  );
  return groups.flat();
});

export const VolumeSnapshotProvider = () =>
  Provider.succeed(VolumeSnapshot, {
    stables: ["snapshotId", "volumeId", "appName"],
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredApp = appNameOf(news.app);
      const appChanged =
        desiredApp !== undefined && desiredApp !== output.appName;
      const desiredVolume = volumeIdOf(news.volume);
      const volumeChanged =
        desiredVolume !== undefined && desiredVolume !== output.volumeId;
      if (appChanged || volumeChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const appName =
        output?.appName ?? appNameOf(olds?.app) ?? appNameOf(olds?.volume);
      const volumeId = output?.volumeId ?? volumeIdOf(olds?.volume);
      if (appName === undefined || volumeId === undefined) return undefined;
      const snapshotId = output?.snapshotId;
      if (snapshotId === undefined || snapshotId.length === 0) {
        return undefined;
      }
      const found = yield* findById(appName, volumeId, snapshotId);
      if (found === undefined) return undefined;
      return toAttrs(appName, volumeId, found);
    }),

    list: Effect.fn(function* () {
      const volumes = yield* listOwnedVolumes();
      const groups = yield* Effect.forEach(
        volumes,
        ({ appName, volumeId }) =>
          listSnapshots(appName, volumeId).pipe(
            Effect.map((snapshots) =>
              snapshots
                .filter(
                  (snapshot) =>
                    snapshot.id !== undefined && snapshot.id.length > 0,
                )
                .map((snapshot) => toAttrs(appName, volumeId, snapshot)),
            ),
          ),
        { concurrency: 8 },
      );
      return groups.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as VolumeSnapshotProps);
      const appName =
        appNameOf(props.app) ?? appNameOf(props.volume) ?? output?.appName;
      const volumeId = volumeIdOf(props.volume) ?? output?.volumeId;
      if (appName === undefined || volumeId === undefined) {
        return yield* new VolumeSnapshotRefsMissing({
          message:
            "Fly.VolumeSnapshot requires a resolved App with appName and a Volume with volumeId.",
        });
      }

      // Observe by cached snapshot id on the target volume.
      const observed = yield* listSnapshots(appName, volumeId);
      let current =
        output?.snapshotId !== undefined && output.snapshotId.length > 0
          ? observed.find((snapshot) => snapshot.id === output.snapshotId)
          : undefined;

      if (current === undefined) {
        const knownIds = new Set(
          observed.flatMap((snapshot) =>
            snapshot.id !== undefined && snapshot.id.length > 0
              ? [snapshot.id]
              : [],
          ),
        );
        yield* Services.machines
          .createVolumeSnapshot({
            app_name: appName,
            volume_id: volumeId,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTag("Conflict", () => Effect.void),
            Effect.retry({
              while: (e) =>
                e._tag === "NotFound" ||
                (e._tag === "BadRequest" &&
                  e.message.includes("uninitialized volume")),
              times: 8,
              schedule: backoff,
            }),
          );
        current = yield* waitForNewSnapshot(appName, volumeId, knownIds);
      }

      if (current === undefined || current.id === undefined) {
        return yield* new VolumeSnapshotNotCreated({ appName, volumeId });
      }

      return toAttrs(appName, volumeId, current);
    }),

    delete: Effect.fn(function* () {
      // Fly has no snapshot delete API. Snapshots expire with Volume
      // snapshot_retention or when the Volume is deleted.
    }),
  });
