import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Sandbox } from "./Sandbox.ts";
import type { Volume } from "./Volume.ts";

/**
 * A volume a mount names: a `Daytona.Volume` (or the reference
 * `MountVolume` returns), or a runtime handle from `CreateVolume`.
 */
export interface MountableVolume {
  readonly volumeId: string | Effect.Effect<string, never, RuntimeContext>;
}

/** A volume mounted at a path: an entry of `mounts`. */
export interface VolumeMount {
  /** The volume. */
  readonly volume: MountableVolume;
  /** Absolute path in the sandbox. */
  readonly path: string;
  /** Mount only this directory of the volume. */
  readonly subpath?: string;
}

export interface MountVolumeOptions {
  /** Absolute path in the sandbox. */
  readonly path: string;
  /** Mount only this directory of the volume. */
  readonly subpath?: string;
}

/** The volume ID behind a mount entry. */
export const volumeIdOf = (volume: MountableVolume) =>
  typeof volume.volumeId === "string" ? Effect.succeed(volume.volumeId) : volume.volumeId;

const isSandboxHost = (value: unknown): value is Sandbox =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Daytona.Sandbox";

/**
 * Mount a {@link Volume} at a path.
 *
 * Inside a sandbox's program, the volume is mounted into that sandbox:
 * it joins the sandbox's `mounts`. A mount change replaces the sandbox,
 * since Daytona only mounts volumes when it creates one. Inside any other
 * host (a Worker, a Lambda), the binding resolves the volume and returns a
 * mount reference to pass to `CreateSandbox`'s `create({ mounts })`.
 *
 * The reference has the same fields as a `mounts` entry: `volume`,
 * `path` and `subpath`. Daytona has no per-volume access control, so the
 * binding mints no credentials.
 *
 * ### Mounting a Volume in a Program
 * **Example:** Serve the files of a volume
 * ```typescript
 * export default class Agent extends Daytona.Sandbox<Agent>()(
 *   "Agent",
 *   { main: import.meta.url, public: true },
 *   Effect.gen(function* () {
 *     const data = yield* Daytona.MountVolume(Data, { path: "/data" });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* fs.readDirectory(data.path));
 *       }),
 *     };
 *   }).pipe(Effect.provide(Daytona.MountVolumeLive)),
 * ) {}
 * ```
 *
 * ### Mounting a Volume in Sandboxes You Create
 * **Example:** A shared cache plus each user's home
 * ```typescript
 * const cache = yield* Daytona.MountVolume(Cache, { path: "/cache" });
 * const sandboxes = yield* Daytona.CreateSandbox(Base);
 * const volumes = yield* Daytona.CreateVolume({ prefix: "user-" });
 * return {
 *   fetch: Effect.gen(function* () {
 *     const home = yield* volumes.getOrCreate({ name: `user-${user}` });
 *     const sandbox = yield* sandboxes.create({
 *       mounts: [cache, { volume: home, path: "/home/daytona/work" }],
 *     });
 *     return yield* HttpServerResponse.json(yield* sandbox.exec("ls /cache"));
 *   }),
 * };
 * ```
 *
 * @binding
 * @product Volume
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "Daytona.MountVolume",
  (volume: Volume, options: MountVolumeOptions) => Effect.Effect<VolumeMount>
> {}

export const MountVolume = Binding.Service<MountVolume>("Daytona.MountVolume");

/** {@link MountVolume}; works on any host. */
export const MountVolumeLive = Layer.effect(
  MountVolume,
  Effect.succeed(
    Effect.fn(function* (volume: Volume, options: MountVolumeOptions) {
      const volumeId = yield* volume.volumeId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isSandboxHost(host)) {
          yield* host.bind`Daytona.MountVolume(${volume})`({
            mounts: [{ volumeId: volume.volumeId, path: options.path, subpath: options.subpath }],
          });
        }
      }
      return {
        volume: { volumeId },
        path: options.path,
        subpath: options.subpath,
      } satisfies VolumeMount;
    }),
  ),
);
