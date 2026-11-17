/**
 * The volume-content client over E2B's HTTP API.
 *
 * Volume content is authenticated with the volume's own token, which the
 * control plane returns from `getVolume` (team key). The token is fetched
 * once per volume on first use and kept for the life of the runtime; a failed
 * lookup is not cached, so the next call retries it.
 */
import { volumeConnectionFor } from "@distilled.cloud/e2b";
import type { VolumeConnection } from "@distilled.cloud/e2b/Credentials";
import * as volumeContent from "@distilled.cloud/e2b/volume_content";
import * as volumes from "@distilled.cloud/e2b/volumes";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type { E2BAuth } from "../E2BBindings.ts";
import type { ReadWriteVolumeClient } from "../VolumeFiles.ts";

const decoder = new TextDecoder();

/** The volume-token connection plus an HTTP client: what volume-content calls need. */
type VolumeLayer = Layer.Layer<VolumeConnection | HttpClient.HttpClient>;

export const makeVolumeFiles = (
  auth: E2BAuth,
  volumeIdOf: Effect.Effect<string>,
): ReadWriteVolumeClient => {
  let cached: { readonly volumeId: string; readonly layer: VolumeLayer } | undefined;
  /** The volume-token connection, looked up once. */
  const connection = Effect.suspend(() =>
    cached !== undefined
      ? Effect.succeed(cached)
      : Effect.flatMap(volumeIdOf, (volumeId) =>
          auth.authorize(volumes.getVolume({ volumeID: volumeId })).pipe(
            Effect.map((volume) => {
              cached = {
                volumeId,
                layer: Layer.mergeAll(volumeConnectionFor(volume), FetchHttpClient.layer),
              };
              return cached;
            }),
          ),
        ),
  );
  /** Runs a volume-content call, given the volume id, with the volume's token. */
  const inVolume = <A, E>(
    call: (volumeID: string) => Effect.Effect<A, E, Layer.Success<VolumeLayer>>,
  ) =>
    Effect.flatMap(connection, ({ volumeId, layer }) => call(volumeId).pipe(Effect.provide(layer)));

  return {
    read: (path) => inVolume((volumeID) => volumeContent.readVolumeFile({ volumeID, path })),
    readText: (path) =>
      inVolume((volumeID) => volumeContent.readVolumeFile({ volumeID, path })).pipe(
        Effect.map((bytes) => decoder.decode(bytes)),
      ),
    list: (path, options) =>
      inVolume((volumeID) =>
        volumeContent.listVolumeDir({
          volumeID,
          path,
          ...(options?.depth === undefined ? {} : { depth: options.depth }),
        }),
      ),
    stat: (path) => inVolume((volumeID) => volumeContent.statVolumePath({ volumeID, path })),
    exists: (path) =>
      inVolume((volumeID) => volumeContent.statVolumePath({ volumeID, path })).pipe(
        Effect.as(true),
        Effect.catchTag("NotFound", () => Effect.succeed(false)),
      ),
    write: (path, data, options) =>
      inVolume((volumeID) =>
        volumeContent.writeVolumeFile({ volumeID, path, body: data, force: true, ...options }),
      ),
    makeDir: (path, options) =>
      inVolume((volumeID) =>
        volumeContent.makeVolumeDir({ volumeID, path, force: true, ...options }),
      ),
    chmod: (path, options) =>
      inVolume((volumeID) => volumeContent.updateVolumePath({ volumeID, path, ...options })),
    remove: (path) =>
      inVolume((volumeID) => volumeContent.removeVolumePath({ volumeID, path })).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
      ),
  };
};
