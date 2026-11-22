import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindE2B } from "./E2BBindings.ts";
import { makeVolumeFiles } from "./internal/VolumeHttp.ts";
import { ReadWriteVolume } from "./ReadWriteVolume.ts";
import type { Volume } from "./Volume.ts";

/**
 * HTTP implementation of {@link ReadWriteVolume}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const cache = yield* E2B.ReadWriteVolume(Cache);
 *   // ...
 * }).pipe(Effect.provide(E2B.ReadWriteVolumeHttp))
 * ```
 *
 * @layer
 * @product Volume
 * @provides E2B.ReadWriteVolume
 */
export const ReadWriteVolumeHttp = Layer.succeed(
  ReadWriteVolume,
  Effect.fn("E2B.ReadWriteVolume")(function* (volume: Volume) {
    const auth = yield* bindE2B;
    const volumeId = yield* (volume.volumeId as Output.Output<string, never>).asEffect();
    return makeVolumeFiles(auth, volumeId);
  }),
);
