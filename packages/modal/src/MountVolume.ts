import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ModalBindings from "./ModalBindings.ts";
import type { MountedVolume, VolumeMount, VolumeMountOptions } from "./Mounts.ts";
import type { Volume } from "./Volume.ts";

/** What `Modal.MountVolume` returns: a mount entry, ready for `mounts`. */
export type VolumeMountRef = VolumeMount<MountedVolume>;

/**
 * Mount a `Modal.Volume` at `path`.
 *
 * - In a `Modal.Function`, `Modal.Server` or `Modal.Sandbox` program, the
 *   volume is mounted into every container the program runs in: read it at
 *   `path` with the filesystem.
 * - In any other runtime (a Worker, a Lambda), the binding grants the
 *   runtime's Modal identity access to the volume's environment and returns
 *   the entry to pass to `sandboxes.create({ mounts })`.
 *
 * The returned reference holds the same fields as a plain entry
 * (`{ volume, path, readOnly?, subPath? }`).
 *
 * ### Mount into a program
 * **Example:** A Function reading model weights from a volume
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as FileSystem from "effect/FileSystem";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Backend, Weights } from "./Backend.ts";
 *
 * export default class Embed extends Modal.Function<Embed>()(
 *   "Embed",
 *   { main: import.meta.url, app: Backend, gpu: "L4" },
 *   Effect.gen(function* () {
 *     const weights = yield* Modal.MountVolume(Weights, { path: "/weights", readOnly: true });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* fs.readDirectory(weights.path));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.MountVolumeLive)),
 * ) {}
 * ```
 *
 * ### Mount into a sandbox you create
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * const data = yield* Modal.MountVolume(Data, { path: "/data" });
 * const sandboxes = yield* Modal.CreateSandbox(Coder);
 * // per request
 * const sandbox = yield* sandboxes.create({ mounts: [data] });
 * ```
 *
 * @binding
 * @product Volume
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "Modal.MountVolume",
  (volume: Volume, options: VolumeMountOptions) => Effect.Effect<VolumeMountRef>
> {}

export const MountVolume = Binding.Service<MountVolume>("Modal.MountVolume");

/** Runtimes that mount volumes into their own containers. */
export const MODAL_RUNTIMES = new Set(["Modal.Function", "Modal.Server", "Modal.Sandbox"]);

/** A Modal runtime's `bind`, typed for the `mounts` slice of its binding contract. */
export type MountHost = {
  bind: (
    label: TemplateStringsArray,
    ...args: unknown[]
  ) => (data: { readonly mounts: ReadonlyArray<unknown> }) => Effect.Effect<void>;
};

/**
 * {@link MountVolume}: binds the entry into a Modal runtime's `mounts`, or
 * grants another runtime's identity access to the volume's environment.
 *
 * @layer
 * @product Volume
 * @provides Modal.MountVolume
 */
export const MountVolumeLive = Layer.effect(
  MountVolume,
  Effect.gen(function* () {
    const bind = yield* ModalBindings.Bind;
    return Effect.fn("Modal.MountVolume")(function* (volume: Volume, options: VolumeMountOptions) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (host !== undefined && MODAL_RUNTIMES.has(host.Type)) {
          yield* (host as unknown as MountHost).bind`Modal.MountVolume(${volume})`({
            mounts: [{ volume, ...options }],
          });
        } else {
          yield* bind`Modal.MountVolume(${volume})`({
            roles: [
              {
                environment: volume.environment,
                role: options.readOnly ? "viewer" : "contributor",
              },
            ],
          });
        }
      }
      const volumeId = yield* volume.volumeId;
      return { ...options, volume: { volumeId } } satisfies VolumeMountRef;
    });
  }),
);
