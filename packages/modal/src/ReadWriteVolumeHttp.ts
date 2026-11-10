import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import { ReadWriteVolume } from "./ReadWriteVolume.ts";
import type { Volume } from "./Volume.ts";
import { makeReadWriteVolumeClient } from "./VolumeClient.ts";
import { VolumeFileOps } from "./VolumeFiles.ts";

/**
 * {@link ReadWriteVolume} over Modal's volume API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the volume's environment.
 *
 * @layer
 * @product Volume
 * @provides Modal.ReadWriteVolume
 */
export const ReadWriteVolumeHttp = Layer.effect(
  ReadWriteVolume,
  makeModalBinding({
    tag: "Modal.ReadWriteVolume",
    operations: VolumeFileOps,
    role: "contributor",
    make: Effect.fn(function* (volume: Volume, ops) {
      const volumeId = yield* volume.volumeId;
      return makeReadWriteVolumeClient(volumeId, ops);
    }),
  }),
);
