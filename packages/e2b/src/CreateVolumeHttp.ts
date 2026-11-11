import * as volumes from "@distilled.cloud/e2b/volumes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CreateVolume, type VolumeHandle, type VolumesClient } from "./CreateVolume.ts";
import { bindE2B, type E2BAuth } from "./E2BBindings.ts";
import { makeVolumeFiles } from "./internal/VolumeHttp.ts";

const handleOf = (auth: E2BAuth, volume: { volumeID: string; name: string }): VolumeHandle => ({
  volumeId: volume.volumeID,
  name: volume.name,
  files: makeVolumeFiles(auth, Effect.succeed(volume.volumeID)),
});

/**
 * HTTP implementation of {@link CreateVolume}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const volumes = yield* E2B.CreateVolume();
 *   // ...
 * }).pipe(Effect.provide(E2B.CreateVolumeHttp))
 * ```
 *
 * @layer
 * @product Volume
 * @provides E2B.CreateVolume
 */
export const CreateVolumeHttp = Layer.succeed(
  CreateVolume,
  Effect.fn("E2B.CreateVolume")(function* () {
    const auth = yield* bindE2B;
    const findByName = (name: string) =>
      auth
        .authorize(volumes.listVolumes({}))
        .pipe(Effect.map((all) => all.find((volume) => volume.name === name)));
    const get = (nameOrId: string) =>
      auth.authorize(volumes.getVolume({ volumeID: nameOrId })).pipe(
        Effect.map((volume): { volumeID: string; name: string } | undefined => volume),
        Effect.catchTag("NotFound", () => findByName(nameOrId)),
        Effect.map((volume) => (volume === undefined ? undefined : handleOf(auth, volume))),
      );
    const client: VolumesClient = {
      create: (name) =>
        auth
          .authorize(volumes.createVolume({ name }))
          .pipe(Effect.map((volume) => handleOf(auth, volume))),
      get,
      getOrCreate: (name) =>
        Effect.flatMap(get(name), (existing) =>
          existing !== undefined
            ? Effect.succeed(existing)
            : auth.authorize(volumes.createVolume({ name })).pipe(
                Effect.map((volume) => handleOf(auth, volume)),
                // A concurrent create won the name: use theirs.
                Effect.catchTag("Conflict", (error) =>
                  Effect.flatMap(get(name), (raced) =>
                    raced === undefined ? Effect.fail(error) : Effect.succeed(raced),
                  ),
                ),
              ),
        ),
      list: () =>
        auth
          .authorize(volumes.listVolumes({}))
          .pipe(
            Effect.map((all) =>
              all.map((volume) => ({ volumeId: volume.volumeID, name: volume.name })),
            ),
          ),
      delete: (volumeId) =>
        auth.authorize(volumes.deleteVolume({ volumeID: volumeId })).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
    };
    return client;
  }),
);
