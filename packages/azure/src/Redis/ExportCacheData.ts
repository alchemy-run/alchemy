import type * as redis from "@distilled.cloud/azure/redis";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cache } from "./Cache.ts";

export interface ExportCacheDataRequest extends Omit<
  redis.ExportRedisDataRequest,
  "subscriptionId" | "resourceGroupName" | "name"
> {}

/**
 * Export a Premium Azure Cache for Redis to RDB blobs in a storage container
 * (`POST …/redis/{cache}/export`).
 *
 * Binding assigns a custom role (`AzureRedisExportCacheDataRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Cache/redis/export/action`, on the cache only. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`).
 * Provide {@link ExportCacheDataHttp}.
 *
 * ### Calling ExportCacheData
 * **Example:** ExportCacheData from a Function
 * ```typescript
 * // init
 * const exportCacheData = yield* Azure.Redis.ExportCacheData(cache);
 *
 * // runtime
 * yield* exportCacheData({
 *   prefix: "nightly",
 *   container: "https://backups.blob.core.windows.net/redis?<sas>",
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const exportCacheData = yield* Azure.Redis.ExportCacheData(cache);
 *   // ...
 * }).pipe(Effect.provide(Azure.Redis.ExportCacheDataHttp));
 * ```
 *
 * @binding
 * @category Redis
 */
export interface ExportCacheData extends Binding.Service<
  ExportCacheData,
  "Azure.Redis.ExportCacheData",
  (
    cache: Cache,
  ) => Effect.Effect<
    (
      request: ExportCacheDataRequest,
    ) => Effect.Effect<redis.ExportRedisDataResponse, redis.ExportRedisDataError, RuntimeContext>
  >
> {}

export const ExportCacheData = Binding.Service<ExportCacheData>("Azure.Redis.ExportCacheData");
