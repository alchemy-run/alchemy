/**
 * BuildKit layer-cache configuration shared by every Alchemy resource that
 * builds a container image: `Docker.Image`, `Cloudflare.Container`, the
 * `AWS.ECS`/`AWS.EKS`/`Kubernetes` image sources, `GCP.Run`, `AWS.ECR.Image`
 * and `AWS.Lambda` image functions.
 */

import * as Schema from "effect/Schema";
import type { RegistryCredentials } from "./Docker.ts";
import { repositoryFromImageRef } from "./Registry.ts";

/**
 * Where an image build imports layer caches from and exports them to, as
 * BuildKit's own `--cache-from` / `--cache-to` values, e.g.
 * `"type=gha,scope=app,mode=max"`. See
 * [cache backends](https://docs.docker.com/build/cache/backends/).
 *
 * Exporting a cache needs a builder that supports it: a `docker-container`
 * Buildx builder (what `docker/setup-buildx-action` creates in CI), or the
 * `docker` driver with the containerd image store. Backends such as `gha`
 * and `s3` take credentials from the environment; values reach `docker`'s
 * argv, so never put secrets in them.
 */
export interface BuildCache {
  /** Cache sources (`--cache-from`), imported in order. */
  from?: ReadonlyArray<string>;
  /** Cache destinations (`--cache-to`). */
  to?: ReadonlyArray<string>;
}

/** Decodes a `cache` option: `true`/`false` or a {@link BuildCache}. */
export const BuildCacheSchema = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    from: Schema.String.pipe(Schema.Array, Schema.optionalKey),
    to: Schema.String.pipe(Schema.Array, Schema.optionalKey),
  }),
]);

/** The `cache` option of an image build. */
export interface BuildCacheOptions {
  /**
   * Keep the image's build layers in a remote cache, so a builder that has
   * never built it (a fresh CI runner, another machine) skips unchanged
   * steps. Without it, builds reuse only the local BuildKit cache of the
   * machine they run on.
   *
   * `true` imports and exports a registry cache at the `:buildcache` tag of
   * the repository the image is published to, keeping every stage's layers
   * (`mode=max`), not only the final image's. For another backend, pass
   * BuildKit's own `--cache-from` / `--cache-to` values as `from` and `to`.
   * The cache is never part of the image's content hash, so changing it
   * never rebuilds an image.
   *
   * @default false
   *
   * @example
   * ```typescript
   * // Registry cache next to the image:
   * build: { cache: true }
   *
   * // GitHub Actions cache:
   * build: {
   *   cache: {
   *     from: ["type=gha,scope=app"],
   *     to: ["type=gha,scope=app,mode=max"],
   *   },
   * }
   * ```
   */
  cache?: boolean | BuildCache;
}

/**
 * `--cache-from` / `--cache-to` values for a `cache` option. `true` uses a
 * registry cache at `ref` (the target repository's `:buildcache`), stored as
 * an OCI image manifest, the format every registry accepts (ECR rejects
 * BuildKit's default cache index).
 */
export const resolveBuildCache = (
  cache: boolean | BuildCache | undefined,
  ref: string,
): { "cache-from": string[]; "cache-to": string[] } =>
  cache === true
    ? {
        "cache-from": [`type=registry,ref=${ref}`],
        "cache-to": [`type=registry,ref=${ref},mode=max,image-manifest=true,oci-mediatypes=true`],
      }
    : { "cache-from": [...((cache || {}).from ?? [])], "cache-to": [...((cache || {}).to ?? [])] };

/** The `:buildcache` ref in the repository of an image ref (`repo:tag` or `repo@digest`). */
export const buildCacheRef = (imageRef: string): string =>
  `${repositoryFromImageRef(imageRef)}:buildcache`;

/**
 * `docker.image.build` options for the `cache` option of an image published
 * to `imageUri`. The build authenticates with the push `credentials`, so it
 * can import and export a cache in the target registry.
 */
export const imageBuildCacheOptions = (
  options: BuildCacheOptions | undefined,
  imageUri: string,
  credentials: RegistryCredentials | undefined,
): {
  "cache-from"?: string[];
  "cache-to"?: string[];
  credentials?: RegistryCredentials;
} =>
  options?.cache
    ? { ...resolveBuildCache(options.cache, buildCacheRef(imageUri)), credentials }
    : {};
