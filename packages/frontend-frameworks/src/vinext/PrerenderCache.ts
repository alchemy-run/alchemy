/**
 * Deploy-time prerender → KV seed pairs.
 *
 * Does **not** reimplement the pair walk. Calls the project's
 * `@vinext/cloudflare` `buildPrerenderKVPairs` (same module official
 * `vinext-cloudflare deploy` uses):
 *
 * https://github.com/cloudflare/vinext/blob/main/packages/cloudflare/src/prerender-kv-populate.ts
 *
 * Flow: `vite build` + vinext prerender write `dist/server` artifacts;
 * deploy loads that helper from the app's `@vinext/cloudflare` install and
 * uploads pairs into `VINEXT_KV_CACHE`. That helper accepts `appPrefix`;
 * we pass none so seeded keys match a default `kvDataAdapter()`.
 */
import * as Effect from "effect/Effect";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleLoadError } from "../core/Loader.ts";

export const VINEXT_KV_CACHE_BINDING = "VINEXT_KV_CACHE";
export const VINEXT_CACHE_BINDING = "VINEXT_CACHE";

export type VinextPrerenderKVPair = {
  key: string;
  value: string;
  expirationTtl?: number;
  metadata?: Record<string, unknown>;
};

type UpstreamKVBulkPair = {
  key: string;
  value: string;
  expiration_ttl?: number;
  metadata?: Record<string, unknown>;
};

export const vinextCacheNamespaceFromEnv = (
  env: Record<string, unknown>,
): { namespaceId: string; accountId?: string } | undefined => {
  const raw = env[VINEXT_KV_CACHE_BINDING] ?? env[VINEXT_CACHE_BINDING];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const namespaceId = (raw as { namespaceId?: unknown }).namespaceId;
  const accountId = (raw as { accountId?: unknown }).accountId;
  if (typeof namespaceId !== "string") {
    return undefined;
  }
  return {
    namespaceId,
    accountId: typeof accountId === "string" ? accountId : undefined,
  };
};

/**
 * Resolve `@vinext/cloudflare`'s `prerender-kv-populate` from `projectRoot`.
 * The function is not on the package `exports` map — load the sibling of
 * the exported `cache/kv-key` entry (same layout as the published dist).
 */
const loadBuildPrerenderKVPairs = (
  projectRoot: string,
): Effect.Effect<
  (
    serverDir: string,
    options?: { appPrefix?: string; now?: number; ttlSeconds?: number },
  ) => { routeCount: number; pairs: UpstreamKVBulkPair[] },
  ModuleLoadError
> =>
  Effect.tryPromise({
    try: async () => {
      const from = pathToFileURL(
        nodePath.join(projectRoot, "package.json"),
      ).href;
      const kvKeyPath = fileURLToPath(
        import.meta.resolve("@vinext/cloudflare/cache/kv-key", from),
      );
      const populateHref = pathToFileURL(
        nodePath.join(
          nodePath.dirname(kvKeyPath),
          "..",
          "prerender-kv-populate.js",
        ),
      ).href;
      const mod = (await import(populateHref)) as {
        buildPrerenderKVPairs: (
          serverDir: string,
          options?: { appPrefix?: string; now?: number; ttlSeconds?: number },
        ) => { routeCount: number; pairs: UpstreamKVBulkPair[] };
      };
      return mod.buildPrerenderKVPairs;
    },
    catch: (cause) =>
      new ModuleLoadError({
        specifier: "@vinext/cloudflare/prerender-kv-populate",
        root: projectRoot,
        cause,
      }),
  });

const toAlchemyPair = (pair: UpstreamKVBulkPair): VinextPrerenderKVPair => ({
  key: pair.key,
  value: pair.value,
  ...(pair.expiration_ttl !== undefined
    ? { expirationTtl: pair.expiration_ttl }
    : {}),
  ...(pair.metadata !== undefined ? { metadata: pair.metadata } : {}),
});

/**
 * Build KV seed pairs for `serverDir` via the app's `@vinext/cloudflare`.
 */
export const buildVinextPrerenderKVPairs = (
  projectRoot: string,
  serverDir: string,
): Effect.Effect<
  { routeCount: number; pairs: VinextPrerenderKVPair[] },
  ModuleLoadError
> =>
  Effect.gen(function* () {
    const buildPrerenderKVPairs = yield* loadBuildPrerenderKVPairs(projectRoot);
    const { routeCount, pairs } = buildPrerenderKVPairs(serverDir);
    return {
      routeCount,
      pairs: pairs.map(toAlchemyPair),
    };
  });

/** @internal */
export const _prerenderCacheForTests = {
  loadUpstreamBuildPrerenderKVPairs: loadBuildPrerenderKVPairs,
  toAlchemyPair,
};
