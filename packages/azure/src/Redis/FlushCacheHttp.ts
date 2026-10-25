import * as redis from "@distilled.cloud/azure/redis";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Cache } from "./Cache.ts";
import { FlushCache } from "./FlushCache.ts";

/**
 * Implementation of {@link FlushCache} over the distilled `redis` ARM
 * operation `FlushRedisCache`. Assigns the custom `AzureRedisFlushCacheRole` on
 * the cache.
 *
 * @layer
 * @provides Azure.Redis.FlushCache
 */
export const FlushCacheHttp = Layer.effect(
  FlushCache,
  makeArmActionBinding({
    tag: "Azure.Redis.FlushCache",
    operation: redis.FlushRedisCache,
    role: {
      role: "RedisFlushCache",
      actions: ["Microsoft.Cache/redis/flush/action"],
    },
    resourceId: (cache: Cache) => cache.cacheId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      cacheName: id.name("redis"),
    }),
  }),
);
