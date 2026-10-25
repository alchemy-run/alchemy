import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** The `GetServiceStatistics` request without the `url` the bound account supplies. */
export interface GetQueueServiceStatisticsRequest extends Omit<
  queues.GetServiceStatisticsRequest,
  "url"
> {}

/**
 * Read the geo-replication status of an Azure Storage account's queue service (Get Queue Service Stats) on any host. The call goes to the `-secondary` endpoint, so the account needs read-access geo-redundant storage (`Standard_RAGRS` or `Standard_RAGZRS`).
 *
 * Binding assigns a custom role with only the `queueServices/read` action
 * on the storage account.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetQueueServiceStatisticsHttp}.
 *
 * ### Reading Geo-Replication Status
 * **Example:** Report the last sync time
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: assigns the role on the account
 *     const getServiceStatistics = yield* Azure.Storage.GetQueueServiceStatistics(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const stats = yield* getServiceStatistics();
 *         return yield* HttpServerResponse.json({
 *           status: stats.GeoReplication?.Status,
 *           lastSyncTime: stats.GeoReplication?.LastSyncTime,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetQueueServiceStatisticsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetQueueServiceStatistics extends Binding.Service<
  GetQueueServiceStatistics,
  "Azure.Storage.GetQueueServiceStatistics",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: GetQueueServiceStatisticsRequest,
    ) => Effect.Effect<
      queues.GetServiceStatisticsResponse,
      queues.GetServiceStatisticsError,
      RuntimeContext
    >
  >
> {}

export const GetQueueServiceStatistics = Binding.Service<GetQueueServiceStatistics>(
  "Azure.Storage.GetQueueServiceStatistics",
);
