/**
 * Platform-selected vinext `cache` options.
 *
 * Vinext bakes `vinext({ cache })` into the RSC bundle at build time
 * (`options.cache` on the vinext() plugin — a sibling Vite plugin is
 * not consulted). Which backend to bake is a platform fact:
 *
 * - Node (`vinext/node` build) sets `ALCHEMY_VINEXT_CACHE=redis`
 * - AWS (`vinext/aws` build) sets `ALCHEMY_VINEXT_CACHE=s3`
 * - Cloudflare (`Website.Vinext`) sets `ALCHEMY_VINEXT_CACHE=kv`
 *
 * ```ts
 * import { alchemy } from "@alchemy.run/frontend-frameworks/vinext/cache";
 * import vinext from "vinext";
 *
 * export default defineConfig({
 *   plugins: [vinext({ prerender: true, ...alchemy() })],
 * });
 * ```
 *
 * Plain `vinext build` / `alchemy dev` leave this empty — in-memory
 * handler. At runtime, missing `REDIS_URL` / `CACHE_BUCKET_NAME` /
 * `VINEXT_KV_CACHE` also falls back to memory.
 */
import { kvAdapter } from "./kv.ts";
import { redisAdapter } from "./redis.ts";
import { s3Adapter } from "./s3.ts";

export const ALCHEMY_VINEXT_CACHE_ENV = "ALCHEMY_VINEXT_CACHE";

export type VinextCacheKind = "redis" | "s3" | "kv";

/** Subset of vinext `VinextOptions` — keep structural so we don't import `vinext`. */
export type VinextCacheOptions = {
  cache?: {
    data?: { adapter: string; options?: Record<string, unknown> };
    cdn?: { adapter: string; options?: Record<string, unknown> };
  };
};

const resolveKind = (kind?: VinextCacheKind): VinextCacheKind | undefined => {
  if (kind !== undefined) return kind;
  const fromEnv = process.env[ALCHEMY_VINEXT_CACHE_ENV];
  if (fromEnv === "redis" || fromEnv === "s3" || fromEnv === "kv") {
    return fromEnv;
  }
  return undefined;
};

/**
 * Spread into `vinext({ ...alchemy() })`. Selects Redis / S3 / KV from
 * {@link ALCHEMY_VINEXT_CACHE_ENV} (set by the platform build).
 */
export const alchemy = (kind?: VinextCacheKind): VinextCacheOptions => {
  const resolved = resolveKind(kind);
  if (resolved === "redis") return { cache: { data: redisAdapter() } };
  if (resolved === "s3") return { cache: { data: s3Adapter() } };
  if (resolved === "kv") return { cache: { data: kvAdapter() } };
  return {};
};

/** @deprecated Use {@link alchemy} spread into `vinext()`. */
export const alchemyVinextCache = alchemy;
