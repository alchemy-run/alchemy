import * as redis from "@distilled.cloud/azure/redis";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Cache } from "./Cache.ts";
import { ExportCacheData } from "./ExportCacheData.ts";

/**
 * Implementation of {@link ExportCacheData} over the distilled `redis` ARM
 * operation `ExportRedisData`. Assigns the custom `AzureRedisExportCacheDataRole` on
 * the cache.
 *
 * @layer
 * @provides Azure.Redis.ExportCacheData
 */
export const ExportCacheDataHttp = Layer.effect(
  ExportCacheData,
  makeArmActionBinding({
    tag: "Azure.Redis.ExportCacheData",
    operation: redis.ExportRedisData,
    role: {
      role: "RedisExportCacheData",
      actions: ["Microsoft.Cache/redis/export/action"],
    },
    resourceId: (cache: Cache) => cache.cacheId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      name: id.name("redis"),
    }),
  }),
);
