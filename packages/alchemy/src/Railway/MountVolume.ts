import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { Volume } from "./Volume.ts";

export interface MountVolumeOptions {
  /**
   * Absolute path inside the container the Volume is mounted at
   * (e.g. `/data`).
   */
  path: string;
}

/**
 * Runtime view of a Volume mounted into a {@link Service} or
 * `Railway.Function`: the path inside the container.
 */
export interface MountedVolume {
  /** Mount path inside the container (same value as {@link MountVolumeOptions.path}). */
  path: string;
}

/**
 * A volume mount injected onto a {@link Service} via {@link MountVolume}.
 * Service reconcile attaches it with `volumeInstanceUpdate`.
 */
export interface MountSpec {
  /** Railway volume id (not the instance id). */
  volumeId: string;
  /** Absolute path inside the container. */
  path: string;
}

const volumeIdOf = (volume: Volume): string => {
  const value = (volume as { volumeId?: unknown }).volumeId;
  return typeof value === "string" ? value : "";
};

const RAILWAY_BIND_HOST_TYPES = new Set([
  "Railway.Service",
  "Railway.Function",
]);

/**
 * True for a Railway compute host that accepts {@link ServiceBinding}
 * (`Railway.Service` or {@link Function}).
 */
export const isRailwayHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  RAILWAY_BIND_HOST_TYPES.has((value as { Type?: string }).Type ?? "");

/**
 * Binding contract accepted by {@link Service} and
 * `Railway.Function` for mounted volumes and injected env.
 */
export interface ServiceBinding {
  env?: Record<string, any>;
  mounts?: MountSpec[];
}

/**
 * Mount a Railway.Volume into a {@link Service} or `Railway.Function`.
 *
 * `yield* Railway.MountVolume(volume, { path: "/data" })` inside a
 * Service/Function impl registers `{ mounts: [{ volumeId, path }] }` on
 * the host. Reconcile attaches the volume via `volumeInstanceUpdate`.
 *
 * @binding
 *
 * @section Mount into a Service
 * Yield `MountVolume` inside init. Provide {@link MountVolumeLive}.
 * At runtime you get `disk.path`.
 *
 * @example Bind a path
 * ```typescript
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url, registry: "ghcr.io/acme" },
 *   Effect.gen(function* () {
 *     const disk = yield* Railway.MountVolume(Data, { path: "/data" });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const text = yield* fs.readFileString(`${disk.path}/hello.txt`);
 *         return HttpServerResponse.text(text);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Railway.MountVolumeLive)),
 * ) {}
 * ```
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "Railway.MountVolume",
  (volume: Volume, options: MountVolumeOptions) => Effect.Effect<MountedVolume>
> {}

export const MountVolume = Binding.Service<MountVolume>("Railway.MountVolume");

export const MountVolumeLive = Layer.effect(
  MountVolume,
  Effect.succeed(
    Effect.fn(function* (volume: Volume, options: MountVolumeOptions) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isRailwayHost(host)) {
          yield* host.bind`Railway.MountVolume(${options.path})`({
            mounts: [{ volumeId: volumeIdOf(volume), path: options.path }],
          });
        }
      }
      return { path: options.path };
    }),
  ),
);
