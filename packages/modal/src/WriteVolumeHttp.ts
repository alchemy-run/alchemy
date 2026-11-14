import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Volume } from "./Volume.ts";
import { makeWriteVolumeClient } from "./VolumeClient.ts";
import { VolumeFileOps } from "./VolumeFiles.ts";
import { WriteVolume } from "./WriteVolume.ts";

/**
 * {@link WriteVolume} over Modal's volume API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the volume's environment.
 *
 * @layer
 * @product Volume
 * @provides Modal.WriteVolume
 */
export const WriteVolumeHttp = Layer.effect(
  WriteVolume,
  makeModalBinding({
    tag: "Modal.WriteVolume",
    operations: VolumeFileOps,
    role: "contributor",
    make: Effect.fn(function* (volume: Volume, ops) {
      const volumeId = yield* volume.volumeId;
      return makeWriteVolumeClient(volumeId, ops);
    }),
  }),
);
