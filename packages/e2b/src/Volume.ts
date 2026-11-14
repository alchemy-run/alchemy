import * as volumes from "@distilled.cloud/e2b/volumes";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { E2BUnexpectedResponse } from "./Errors.ts";
import { e2bName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface VolumeProps {
  /**
   * Volume name, unique within the team. Letters, digits, `-` and `_`. If
   * omitted, a unique name is generated from the stack, stage and logical ID.
   * Changing it replaces the volume, and its files are lost.
   */
  name?: string;
}

export interface VolumeAttributes {
  /** E2B's volume id. */
  volumeId: string;
  /** The volume's name. Sandboxes mount a volume by name. */
  name: string;
}

export interface Volume extends Resource<
  "E2B.Volume",
  VolumeProps,
  VolumeAttributes,
  never,
  Providers,
  { name: string }
> {}

/**
 * A persistent E2B volume: a team-wide filesystem that sandboxes mount at a
 * path and that outlives every sandbox using it.
 *
 * Declare a volume when every sandbox shares it (a package cache, a
 * dataset). Per-user and per-session volumes are created at runtime by name
 * with `E2B.CreateVolume()`, and both kinds mount the same way.
 *
 * E2B volumes carry no labels, so Alchemy recognises its volumes by their
 * generated name. A volume found under an explicit name without prior state
 * is reported as unowned and is only adopted with `--adopt`.
 *
 * E2B enables volumes per team; on a team without them, a deploy fails
 * with `VolumesNotEnabled`.
 *
 * ### Creating a Volume
 * **Example:** A shared cache volume
 * ```typescript
 * export const Cache = E2B.Volume("Cache", {});
 * ```
 *
 * **Example:** A volume with a fixed name
 * ```typescript
 * export const Datasets = E2B.Volume("Datasets", { name: "datasets" });
 * ```
 *
 * ### Mounting a Volume
 * **Example:** Mount it into a declared sandbox
 * ```typescript
 * export const Builder = E2B.Sandbox("Builder", {
 *   template: Agent,
 *   mounts: [{ volume: Cache, path: "/cache" }],
 * });
 * ```
 *
 * **Example:** Mount it into the sandboxes a Worker creates
 * ```typescript
 * const cache = yield* E2B.MountVolume(Cache, { path: "/cache" });
 * const sandboxes = yield* E2B.CreateSandbox(Agent);
 * // in fetch:
 * const sandbox = yield* sandboxes.create({ mounts: [cache] });
 * ```
 *
 * ### Reading files from outside a sandbox
 * **Example:** Read a report the sandbox wrote
 * ```typescript
 * const reports = yield* E2B.ReadVolume(Reports);
 * const report = yield* reports.readFile("/report.json");
 * ```
 *
 * ### Referencing a volume the stack doesn't manage
 * `E2B.Volume.lookup` finds an existing volume by name. Nothing is created,
 * adopted or deleted.
 *
 * **Example:** Look one up by name
 * ```typescript
 * const datasets = E2B.Volume.lookup({ name: "datasets" });
 * const files = yield* E2B.ReadVolume(datasets);
 * ```
 *
 * @resource
 * @product Volume
 */
export const Volume = Resource<Volume>("E2B.Volume");

const toAttrs = (volume: { volumeID: string; name: string }): VolumeAttributes => ({
  volumeId: volume.volumeID,
  name: volume.name,
});

/** The volume with this name, if any. E2B lists a team's volumes in one page. */
const findByName = (name: string) =>
  volumes.listVolumes({}).pipe(Effect.map((all) => all.find((volume) => volume.name === name)));

const observe = (volumeId: string | undefined, name: string) =>
  volumeId !== undefined
    ? volumes.getVolume({ volumeID: volumeId }).pipe(
        Effect.map((volume): volumes.Volume | undefined => volume),
        Effect.catchTag("NotFound", () => findByName(name)),
      )
    : findByName(name);

export const VolumeProvider = () =>
  Provider.effect(
    Volume,
    Effect.gen(function* () {
      return {
        stables: ["volumeId", "name"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          // Only an explicit name can force a rename; a generated name is
          // engine-owned and never compared against a fresh computation.
          if (news.name === undefined && olds?.name === undefined) return undefined;
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          if (news.name !== name) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name }) {
          const volume = yield* observe(undefined, name);
          return volume === undefined ? undefined : toAttrs(volume);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          const volume = yield* observe(output?.volumeId, name);
          if (volume === undefined) return undefined;
          const attrs = toAttrs(volume);
          return output !== undefined || olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* e2bName(id, news.name));
          // Observe
          const observed = yield* observe(output?.volumeId, name);
          if (observed !== undefined) return toAttrs(observed);
          // Ensure — a Conflict is a peer creating the same name: read it back.
          yield* session.note(`Creating volume ${name}...`);
          const created = yield* volumes.createVolume({ name }).pipe(
            Effect.map((volume): volumes.Volume | undefined => volume),
            Effect.catchTag("Conflict", () => findByName(name)),
          );
          if (created === undefined) {
            return yield* new E2BUnexpectedResponse({
              message: `E2B volume ${name} vanished after create`,
            });
          }
          return toAttrs(created);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* volumes
            .deleteVolume({ volumeID: output.volumeId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const all = yield* volumes.listVolumes({});
          return all.filter((volume) => isGeneratedName(volume.name)).map(toAttrs);
        }),
      };
    }),
  );
