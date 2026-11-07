import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindE2B } from "./E2BBindings.ts";
import { makeVolumeFiles } from "./internal/VolumeHttp.ts";
import { ReadVolume } from "./ReadVolume.ts";
import type { Volume } from "./Volume.ts";

/**
 * HTTP implementation of {@link ReadVolume}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const reports = yield* E2B.ReadVolume(Reports);
 *   // ...
 * }).pipe(Effect.provide(E2B.ReadVolumeHttp))
 * ```
 *
 * @layer
 * @product Volume
 * @provides E2B.ReadVolume
 */
export const ReadVolumeHttp = Layer.succeed(
  ReadVolume,
  Effect.fn("E2B.ReadVolume")(function* (volume: Volume) {
    const auth = yield* bindE2B;
    const volumeId = yield* (volume.volumeId as Output.Output<string, never>).asEffect();
    return makeVolumeFiles(auth, volumeId);
  }),
);
