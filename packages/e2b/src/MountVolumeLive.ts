import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MountVolume, type BoundVolumeMount, type MountVolumeOptions } from "./MountVolume.ts";
import type { Template } from "./Template.ts";
import type { Volume } from "./Volume.ts";

/**
 * The implementation of {@link MountVolume}. It makes no API call: E2B
 * mounts a volume by name when a sandbox is created, so the binding binds
 * the name onto the host and, in an `E2B.Template` program, adds the mount
 * to the template.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const data = yield* E2B.MountVolume(Data, { path: "/data" });
 *   // ...
 * }).pipe(Effect.provide(E2B.MountVolumeLive))
 * ```
 *
 * @layer
 * @product Volume
 * @provides E2B.MountVolume
 */
export const MountVolumeLive = Layer.succeed(
  MountVolume,
  Effect.fn("E2B.MountVolume")(function* (volume: Volume, options: MountVolumeOptions) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      // A mount is part of a template program's own sandboxes, so it is
      // attached to the template itself. `Binding.Host` is typed as a bare
      // `ResourceLike` (a host's binding contract is only known per type),
      // hence the cast once the type is checked.
      if (host?.Type === "E2B.Template") {
        yield* (host as unknown as Template).bind`${volume}`({
          volumes: [{ volume: { name: volume.name }, path: options.path }],
        });
      }
    }
    const name = yield* Output.named(
      volume.name as Output.Output<string, never>,
      `E2B_VOLUME_${volume.LogicalId}`,
    ).asEffect();
    return { volume: { name }, path: options.path } satisfies BoundVolumeMount;
  }),
);
