import * as redis from "@distilled.cloud/azure/redis";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Cache } from "./Cache.ts";
import { ImportCacheData } from "./ImportCacheData.ts";

/**
 * Implementation of {@link ImportCacheData} over the distilled `redis` ARM
 * operation `ImportRedisData`. Assigns the custom `AzureRedisImportCacheDataRole` on
 * the cache.
 *
 * @layer
 * @provides Azure.Redis.ImportCacheData
 */
export const ImportCacheDataHttp = Layer.effect(
  ImportCacheData,
  makeArmActionBinding({
    tag: "Azure.Redis.ImportCacheData",
    operation: redis.ImportRedisData,
    role: {
      role: "RedisImportCacheData",
      actions: ["Microsoft.Cache/redis/import/action"],
    },
    resourceId: (cache: Cache) => cache.cacheId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      name: id.name("redis"),
    }),
  }),
);
