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
 * Exporting anything but `inline` needs a builder that supports it: a
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

/** Decodes a {@link BuildCache}. */
export const BuildCacheSchema = Schema.Struct({
  from: CacheBackendSchema.pipe(Schema.Array, Schema.optionalKey),
  to: CacheBackendSchema.pipe(Schema.Array, Schema.optionalKey),
});

/** The `cache` option of an image build. */
export interface BuildCacheOptions {
  /**
   * BuildKit layer caches to import and export, as
   * [cache backends](https://docs.docker.com/build/cache/backends/). A
   * `registry` backend without `ref` uses the `:buildcache` tag of the
   * repository the image is published to. The cache never changes the image's
   * content hash, so changing it takes effect on the next build.
   *
   * @example
   * ```typescript
   * // Keep every stage's layers, not only the final stage's:
   * build: { cache: { to: [{ type: "registry", mode: "max" }] } }
   *
   * // GitHub Actions cache, falling back to the registry cache:
   * build: {
   *   cache: {
   *     from: [{ type: "gha", scope: "app" }, { type: "registry" }],
   *     to: [{ type: "gha", scope: "app", mode: "max" }],
   *   },
   * }
   * ```
   */
  cache?: BuildCache;
}

/** {@link BuildCache} with defaults applied and `registry` refs filled in. */
export interface ResolvedBuildCache {
  readonly from: readonly CacheBackend[];
  readonly to: readonly CacheBackend[];
  /** The `docker.image.build` options: `--cache-from` / `--cache-to` values. */
  readonly flags: { "cache-from": string[]; "cache-to": string[] };
}

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
 * Apply defaults to a {@link BuildCache} and point every `registry` backend
 * without a `ref` at `ref` (the target repository's `:buildcache` tag).
 * `from` and `to` default independently.
 */
export const resolveBuildCache = (
  cache: BuildCache | undefined,
  options: {
    /** The ref a `registry` backend without one uses. */
    ref: string;
    /** @default [] */
    from?: ReadonlyArray<CacheBackend>;
    /** @default [] */
    to?: ReadonlyArray<CacheBackend>;
  },
): ResolvedBuildCache => {
  const resolve = (backends: ReadonlyArray<CacheBackend>): CacheBackend[] =>
    backends.map((backend) =>
      backend.type === "registry" && backend.ref === undefined
        ? { ...backend, ref: options.ref }
        : backend,
    );
  const from = resolve(cache?.from ?? options.from ?? []);
  const to = resolve(cache?.to ?? options.to ?? []);
  return {
    from,
    to,
    flags: { "cache-from": from.map(formatCacheBackend), "cache-to": to.map(formatCacheBackend) },
  };
};

/** The `:buildcache` ref in the repository of an image ref (`repo:tag` or `repo@digest`). */
export const buildCacheRef = (imageRef: string): string =>
  `${repositoryFromImageRef(imageRef)}:buildcache`;

/**
 * `docker.image.build` options for a `cache` option on an image published to
 * `imageUri`, with no cache by default. A `registry` backend without `ref`
 * uses the target repository's `:buildcache` tag, and the build
 * authenticates with the push `credentials` so it can import and export it.
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
  options?.cache === undefined
    ? {}
    : {
        ...resolveBuildCache(options.cache, { ref: buildCacheRef(imageUri) }).flags,
        credentials,
      };
