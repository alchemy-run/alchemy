import type * as redis from "@distilled.cloud/azure/redis";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cache } from "./Cache.ts";

export interface FlushCacheRequest extends Omit<
  redis.FlushRedisCacheRequest,
  "subscriptionId" | "resourceGroupName" | "cacheName"
> {}

/**
 * Delete every key in every database of an Azure Cache for Redis (`POST
 * …/redis/{cache}/flush`).
 *
 * Binding assigns a custom role (`AzureRedisFlushCacheRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.Cache/redis/flush/action`, on the cache only. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`).
 * Provide {@link FlushCacheHttp}.
 *
 * ### Calling FlushCache
 * **Example:** FlushCache from a Function
 * ```typescript
 * // init
 * const flushCache = yield* Azure.Redis.FlushCache(cache);
 *
 * // runtime
 * yield* flushCache();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const flushCache = yield* Azure.Redis.FlushCache(cache);
 *   // ...
 * }).pipe(Effect.provide(Azure.Redis.FlushCacheHttp));
 * ```
 *
 * @binding
 * @category Redis
 */
export interface FlushCache extends Binding.Service<
  FlushCache,
  "Azure.Redis.FlushCache",
  (
    cache: Cache,
  ) => Effect.Effect<
    (
      request?: FlushCacheRequest,
    ) => Effect.Effect<redis.FlushRedisCacheResponse, redis.FlushRedisCacheError, RuntimeContext>
  >
> {}

export const FlushCache = Binding.Service<FlushCache>("Azure.Redis.FlushCache");
