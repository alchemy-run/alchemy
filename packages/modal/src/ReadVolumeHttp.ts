import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import { ReadVolume } from "./ReadVolume.ts";
import type { Volume } from "./Volume.ts";
import { makeReadVolumeClient } from "./VolumeClient.ts";
import { VolumeFileOps } from "./VolumeFiles.ts";

/**
 * {@link ReadVolume} over Modal's volume API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `viewer` role on the volume's environment.
 *
 * @layer
 * @product Volume
 * @provides Modal.ReadVolume
 */
export const ReadVolumeHttp = Layer.effect(
  ReadVolume,
  makeModalBinding({
    tag: "Modal.ReadVolume",
    operations: VolumeFileOps,
    role: "viewer",
    make: Effect.fn(function* (volume: Volume, ops) {
      const volumeId = yield* volume.volumeId;
      return makeReadVolumeClient(volumeId, ops);
    }),
  }),
);
