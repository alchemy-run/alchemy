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
 * One BuildKit cache backend, written as `--cache-from` / `--cache-to`
 * `type=<type>,<attribute>=<value>,...`. Every attribute other than `type`
 * is passed through unchanged, so any backend and option BuildKit supports
 * works: `inline`, `registry`, `local`, `gha`, `s3`, `azblob`, and their
 * `mode`, `scope`, `compression`, `image-manifest`, ... attributes.
 * Attributes set to `undefined` are left out.
 *
 * A `registry` backend without a `ref` uses the `:buildcache` tag of the
 * repository the image is published to, with the credentials Alchemy
 * publishes with. Other backends authenticate the way BuildKit documents for
 * them (for `gha` and `s3`, environment variables). Never put credentials in
 * attributes: they reach `docker`'s argv.
 *
 * @see https://docs.docker.com/build/cache/backends/
 */
export interface CacheBackend {
  type: "inline" | "registry" | "local" | "gha" | "s3" | "azblob" | (string & {});
  [attribute: string]: string | number | boolean | undefined;
}

/**
 * Where an image build imports layer caches from and exports them to.
 *
 * Exporting a cache needs a builder that supports it: a
 * `docker-container` Buildx builder (what `docker/setup-buildx-action`
 * creates in CI), or the `docker` driver with the containerd image store
 * for `registry`.
 */
export interface BuildCache {
  /** Cache sources, imported in order (`--cache-from`). `[]` imports none. */
  from?: ReadonlyArray<CacheBackend>;
  /** Cache destinations (`--cache-to`). `[]` exports none. */
  to?: ReadonlyArray<CacheBackend>;
}

/** Decodes a {@link CacheBackend}, keeping every attribute. */
export const CacheBackendSchema = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Undefined]),
  ),
]);

/** Decodes a `cache` option: `true`/`false` or a {@link BuildCache}. */
export const BuildCacheSchema = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    from: CacheBackendSchema.pipe(Schema.Array, Schema.optionalKey),
    to: CacheBackendSchema.pipe(Schema.Array, Schema.optionalKey),
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
   * (`mode=max`), not only the final image's. For another backend, list
   * [BuildKit cache backends](https://docs.docker.com/build/cache/backends/)
   * to import (`from`) and export (`to`). The cache is never part of the
   * image's content hash, so changing it never rebuilds an image.
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
   *     from: [{ type: "gha", scope: "app" }],
   *     to: [{ type: "gha", scope: "app", mode: "max" }],
   *   },
   * }
   * ```
   */
  cache?: boolean | BuildCache;
}

/**
 * The `cache: true` backends: every stage's layers at the repository's
 * `:buildcache`, stored as an OCI image manifest, the format every registry
 * accepts (ECR rejects BuildKit's default cache index).
 */
const registryCache: BuildCache = {
  from: [{ type: "registry" }],
  to: [{ type: "registry", mode: "max", "image-manifest": true, "oci-mediatypes": true }],
};

/**
 * Format one backend as a Buildx `--cache-from` / `--cache-to` value,
 * CSV-quoting fields the way Buildx parses them.
 */
export const formatCacheBackend = ({ type, ...attributes }: CacheBackend): string =>
  [
    `type=${type}`,
    ...Object.entries(attributes).flatMap(([key, value]) =>
      value === undefined ? [] : [`${key}=${String(value)}`],
    ),
  ]
    .map((field) => (/[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
    .join(",");

/**
 * `--cache-from` / `--cache-to` values for a `cache` option. A `registry`
 * backend without a `ref` uses `ref`, the target repository's `:buildcache`.
 */
export const resolveBuildCache = (
  cache: boolean | BuildCache | undefined,
  ref: string,
): { "cache-from": string[]; "cache-to": string[] } => {
  const backends = cache === true ? registryCache : cache || {};
  const format = (list: ReadonlyArray<CacheBackend> = []) =>
    list.map((backend) =>
      formatCacheBackend(
        backend.type === "registry" && backend.ref === undefined ? { ...backend, ref } : backend,
      ),
    );
  return { "cache-from": format(backends.from), "cache-to": format(backends.to) };
};

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
