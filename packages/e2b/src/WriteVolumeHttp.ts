import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindE2B } from "./E2BBindings.ts";
import { makeVolumeFiles } from "./internal/VolumeHttp.ts";
import type { Volume } from "./Volume.ts";
import { WriteVolume } from "./WriteVolume.ts";

/**
 * HTTP implementation of {@link WriteVolume}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const inputs = yield* E2B.WriteVolume(Inputs);
 *   // ...
 * }).pipe(Effect.provide(E2B.WriteVolumeHttp))
 * ```
 *
 * @layer
 * @product Volume
 * @provides E2B.WriteVolume
 */
export const WriteVolumeHttp = Layer.succeed(
  WriteVolume,
  Effect.fn("E2B.WriteVolume")(function* (volume: Volume) {
    const auth = yield* bindE2B;
    const volumeId = yield* (volume.volumeId as Output.Output<string, never>).asEffect();
    return makeVolumeFiles(auth, volumeId);
  }),
);
