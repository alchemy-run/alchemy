import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Volume } from "./Volume.ts";

/**
 * A volume to mount: a declared `E2B.Volume`, or a volume `CreateVolume`
 * returned. E2B mounts volumes by name.
 */
export interface MountableVolume {
  readonly name: string;
}

/** A volume mounted into a sandbox at `path`. */
export interface VolumeMount {
  readonly volume: MountableVolume;
  /** Absolute path inside the sandbox. */
  readonly path: string;
}

/**
 * A volume bound to a host with `E2B.MountVolume`. Its name is read at
 * runtime, so pass the whole reference to `mounts`.
 */
export interface BoundVolumeMount {
  readonly volume: { readonly name: Effect.Effect<string, never, RuntimeContext> };
  /** Absolute path inside the sandbox. */
  readonly path: string;
}

export interface MountVolumeOptions {
  /** Absolute path inside the sandbox. */
  readonly path: string;
}

/**
 * Mount a declared `E2B.Volume` at a path.
 *
 * In an `E2B.Template` program, the mount becomes part of the template:
 * every sandbox created from it (with `CreateSandbox(template)` or
 * `E2B.Sandbox({ template })`) mounts the volume, and the program finds its
 * files at `path`. E2B attaches volumes when a sandbox is created, so a
 * sandbox already running keeps the mounts it started with.
 *
 * Anywhere else (a Worker, a Function), it returns a reference to pass to
 * `create({ mounts })`.
 *
 * E2B enables volumes per team; on a team without them, deploying the
 * volume fails with `VolumesNotEnabled`.
 *
 * ### In a template program
 * **Example:** A program that serves a volume's files
 * ```typescript
 * export default class Api extends E2B.Template<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const data = yield* E2B.MountVolume(Data, { path: "/data" });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const files = yield* fs.readDirectory(data.path);
 *         return yield* HttpServerResponse.json(files);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(E2B.MountVolumeLive)),
 * ) {}
 * ```
 *
 * ### From a Worker
 * **Example:** Mount a shared volume and a per-user one
 * ```typescript
 * const data = yield* E2B.MountVolume(Data, { path: "/data" });
 * const sandboxes = yield* E2B.CreateSandbox(Agent);
 * const volumes = yield* E2B.CreateVolume();
 * // in fetch:
 * const home = yield* volumes.getOrCreate(`home-${user}`);
 * const sandbox = yield* sandboxes.create({
 *   mounts: [data, { volume: home, path: "/home/user/work" }],
 * });
 * ```
 *
 * @binding
 * @product Volume
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "E2B.MountVolume",
  (volume: Volume, options: MountVolumeOptions) => Effect.Effect<BoundVolumeMount>
> {}

export const MountVolume = Binding.Service<MountVolume>("E2B.MountVolume");
