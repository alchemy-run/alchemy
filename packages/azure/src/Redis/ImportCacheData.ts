import type * as redis from "@distilled.cloud/azure/redis";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cache } from "./Cache.ts";

export interface ImportCacheDataRequest extends Omit<
  redis.ImportRedisDataRequest,
  "subscriptionId" | "resourceGroupName" | "name"
> {}

/**
 * Import RDB blobs into a Premium Azure Cache for Redis (`POST
 * …/redis/{cache}/import`), replacing its data.
 *
 * Binding assigns a custom role (`AzureRedisImportCacheDataRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Cache/redis/import/action`, on the cache only. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`).
 * Provide {@link ImportCacheDataHttp}.
 *
 * ### Calling ImportCacheData
 * **Example:** ImportCacheData from a Function
 * ```typescript
 * // init
 * const importCacheData = yield* Azure.Redis.ImportCacheData(cache);
 *
 * // runtime
 * yield* importCacheData({
 *   files: ["https://backups.blob.core.windows.net/redis/nightly?<sas>"],
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const importCacheData = yield* Azure.Redis.ImportCacheData(cache);
 *   // ...
 * }).pipe(Effect.provide(Azure.Redis.ImportCacheDataHttp));
 * ```
 *
 * @binding
 * @category Redis
 */
export interface ImportCacheData extends Binding.Service<
  ImportCacheData,
  "Azure.Redis.ImportCacheData",
  (
    cache: Cache,
  ) => Effect.Effect<
    (
      request: ImportCacheDataRequest,
    ) => Effect.Effect<redis.ImportRedisDataResponse, redis.ImportRedisDataError, RuntimeContext>
  >
> {}

export const ImportCacheData = Binding.Service<ImportCacheData>("Azure.Redis.ImportCacheData");
