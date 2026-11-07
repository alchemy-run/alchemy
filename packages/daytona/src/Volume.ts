import * as volumes from "@distilled.cloud/daytona/volumes";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import { waitForState, waitUntilGone } from "./internal/Wait.ts";
import type { Providers } from "./Providers.ts";

export interface VolumeProps {
  /**
   * Volume name, unique in the organization. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces
   * the volume (and its files).
   */
  name?: string;
}

export interface VolumeAttributes {
  /** Volume ID. */
  volumeId: string;
  /** Volume name. */
  name: string;
  /** Volume state (`ready` once usable). */
  state: volumes.VolumeState;
  /** When the volume was created. */
  createdAt: string;
}

export type Volume = Resource<
  "Daytona.Volume",
  VolumeProps,
  VolumeAttributes,
  never,
  Providers,
  VolumeLookup
>;

/**
 * Props for {@link Volume.lookup}: find a volume this stack
 * doesn't manage by its name.
 */
export interface VolumeLookup {
  /** Volume name. */
  name: string;
}

/**
 * A Daytona volume: a persistent disk, backed by object storage, that
 * sandboxes mount at a path. Its files outlive every sandbox that mounts
 * it, and several sandboxes can mount it at once.
 *
 * Declare a volume here for data your whole app shares, like a dataset or
 * a package cache. For a volume per user or per session, create it at
 * runtime with {@link CreateVolume}.
 * @see https://www.daytona.io/docs/en/volumes/
 *
 * ### Creating a Volume
 * **Example:** A shared cache volume
 * ```typescript
 * export const Cache = Daytona.Volume("Cache", {});
 * ```
 *
 * ### Mounting a Volume
 * **Example:** Mount it in a sandbox declared at deploy
 * ```typescript
 * export const DevBox = Daytona.Sandbox("DevBox", {
 *   snapshot: Base,
 *   mounts: [{ volume: Cache, path: "/cache" }],
 * });
 * ```
 *
 * **Example:** Mount it in sandboxes created at runtime
 * ```typescript
 * const cache = yield* Daytona.MountVolume(Cache, { path: "/cache" });
 * const sandbox = yield* sandboxes.create({ mounts: [cache] });
 * ```
 *
 * ### Looking up an existing volume
 * `Volume.lookup` references a volume Alchemy doesn't manage (created in
 * the Daytona dashboard or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Mount an existing volume
 * ```typescript
 * const data = Daytona.Volume.lookup({ name: "datasets" });
 * ```
 *
 * @resource
 * @product Volume
 */
export const Volume = Resource<Volume>("Daytona.Volume");

export const toVolumeAttributes = (v: volumes.VolumeDto): VolumeAttributes => ({
  volumeId: v.id,
  name: v.name,
  state: v.state,
  createdAt: v.createdAt,
});

const isLive = (v: volumes.VolumeDto) =>
  v.state !== "deleted" && v.state !== "deleting" && v.state !== "pending_delete";

export const getVolumeByName = (name: string) =>
  volumes.getVolumeByName({ name }).pipe(
    Effect.map((v) => (isLive(v) ? v : undefined)),
    Effect.catchTag("VolumeNotFound", () => Effect.undefined),
  );

export const getVolumeById = (volumeId: string) =>
  volumes.getVolume({ volumeId }).pipe(
    Effect.map((v) => (isLive(v) ? v : undefined)),
    Effect.catchTag("VolumeNotFound", () => Effect.undefined),
  );

export const waitForVolume = (volumeId: string) =>
  waitForState({
    kind: "volume",
    id: volumeId,
    observe: volumes.getVolume({ volumeId }),
    want: ["ready"],
    fail: ["error"],
    reason: (v) => v.errorReason,
  });

/**
 * The volume named `name`, created if missing. A create racing another
 * caller (`VolumeAlreadyExists`) re-reads the winner.
 */
export const ensureVolume = Effect.fn(function* (name: string) {
  const existing = yield* getVolumeByName(name);
  const volume =
    existing ??
    (yield* volumes
      .createVolume({ name })
      .pipe(Effect.catchTag("VolumeAlreadyExists", () => volumes.getVolumeByName({ name }))));
  return volume.state === "ready" ? volume : yield* waitForVolume(volume.id);
});

/**
 * Delete a volume. With `wait` (deploy), retry while a sandbox still
 * mounts it and wait until it is gone. At run time `wait` is off: a
 * request fails at once with `VolumeInUse` and returns as soon as Daytona
 * accepts the delete. Daytona releases a volume about a minute after the
 * sandbox that wrote to it is deleted, which is longer than a request
 * should wait.
 */
export const deleteVolumeById = Effect.fn(function* (
  volumeId: string,
  options: { readonly wait: boolean } = { wait: true },
) {
  yield* volumes.deleteVolume({ volumeId }).pipe(
    Effect.catchTags({
      VolumeNotFound: () => Effect.void,
      // Refused while the volume is still being created (wait for it) or is
      // already being deleted (nothing left to do).
      VolumeNotReady: (error) =>
        Effect.flatMap(getVolumeById(volumeId), (live) =>
          live === undefined ? Effect.void : Effect.fail(error),
        ),
    }),
    // VolumeInUse: a sandbox still mounts it, e.g. while a destroy deletes
    // the sandboxes alongside; it frees up once they are gone.
    Effect.retry({
      while: (e) => e._tag === "VolumeNotReady" || (options.wait && e._tag === "VolumeInUse"),
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );
  if (!options.wait) return;
  yield* waitUntilGone(
    "volume",
    volumeId,
    getVolumeById(volumeId).pipe(Effect.map((v) => v !== undefined)),
  );
});

export const VolumeProvider = () =>
  Provider.effect(
    Volume,
    Effect.succeed({
      stables: ["volumeId", "createdAt"],
      list: Effect.fn(function* () {
        const all = yield* volumes.listVolumes({});
        return all.filter(isLive).map(toVolumeAttributes);
      }),
      diff: Effect.fn(function* ({ id, news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const name = yield* resolveName(
          id,
          news.name,
          news.name === undefined ? output.name : undefined,
        );
        if (name !== output.name) return { action: "replace", deleteFirst: true } as const;
      }),
      lookup: Effect.fn(function* ({ name }) {
        const found = yield* getVolumeByName(name);
        return found === undefined ? undefined : toVolumeAttributes(found);
      }),

      read: Effect.fn(function* ({ id, olds, output }) {
        const name = yield* resolveName(id, olds?.name, output?.name);
        const found =
          (output ? yield* getVolumeById(output.volumeId) : undefined) ??
          (yield* getVolumeByName(name));
        if (found === undefined) return undefined;
        const attrs = toVolumeAttributes(found);
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        // Observe by id first: the name may already be taken by a peer.
        const name = yield* resolveName(id, news.name, output?.name);
        const byId = output ? yield* getVolumeById(output.volumeId) : undefined;
        // Ensure — volumes have nothing mutable beyond existence.
        const volume =
          byId && byId.name === name
            ? byId.state === "ready"
              ? byId
              : yield* waitForVolume(byId.id)
            : yield* ensureVolume(name);
        return toVolumeAttributes(volume);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* deleteVolumeById(output.volumeId);
      }),
    }),
  );
