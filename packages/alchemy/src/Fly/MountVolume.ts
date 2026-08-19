import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { Volume } from "./Volume.ts";

export interface MountVolumeOptions {
  /**
   * Absolute path inside the Machine the Volume is mounted at
   * (e.g. `/data`).
   */
  path: string;
}

/**
 * Runtime view of a Volume mounted into a {@link Service} (or bound onto
 * a Machine): the path and the Fly Volume id.
 */
export interface MountedVolume {
  /** Mount path inside the Machine (same value as {@link MountVolumeOptions.path}). */
  path: string;
  /** Fly Volume id. */
  volumeId: string;
}

const volumeIdOf = (volume: Volume): string => {
  const value = (volume as { volumeId?: unknown }).volumeId;
  return typeof value === "string" ? value : "";
};

const isBindHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

/**
 * Binding contract accepted by {@link Service} (and Machine) for mounted
 * volumes and injected env.
 */
export interface ServiceBinding {
  env?: Record<string, any>;
  mounts?: Array<{
    volume: string;
    path: string;
  }>;
}

/**
 * Mount a Fly Volume into a {@link Service}.
 *
 * `yield* Fly.MountVolume(volume, { path: "/data" })` inside a Service
 * impl registers `{ mounts: [{ volume, path }] }` on the host. Service
 * reconcile writes them to Machine `config.mounts`. A Volume attaches
 * to one Machine — the same volume on two Services is invalid.
 *
 * @binding
 * @section Mounting volumes
 * @example Mount a Volume into a Service
 * ```typescript
 * const volume = yield* Fly.Volume("data", {
 *   app: site,
 *   sizeGb: 1,
 *   region: "iad",
 * });
 * const mount = yield* Fly.MountVolume(volume, { path: "/data" });
 * // mount.path === "/data"
 * // mount.volumeId === volume.volumeId
 * ```
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "Fly.MountVolume",
  (volume: Volume, options: MountVolumeOptions) => Effect.Effect<MountedVolume>
> {}

export const MountVolume = Binding.Service<MountVolume>("Fly.MountVolume");

export const MountVolumeLive = Layer.effect(
  MountVolume,
  Effect.succeed(
    Effect.fn(function* (volume: Volume, options: MountVolumeOptions) {
      const volumeId = volumeIdOf(volume);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindHost(host)) {
          yield* host.bind`Allow(${host}, Fly.MountVolume(${volume}))`({
            mounts: [{ volume: volume.volumeId, path: options.path }],
          });
        }
      }
      return { path: options.path, volumeId };
    }),
  ),
);
