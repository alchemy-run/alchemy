import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `GetServiceStatistics` request without the `url` the bound account supplies. */
export interface GetBlobServiceStatisticsRequest extends Omit<
  blob.GetServiceStatisticsRequest,
  "url"
> {}

/**
 * Read geo-replication status from the secondary endpoint (`Get Blob Service
 * Stats`). Needs a read-access geo-redundant account (`Standard_RAGRS` or
 * `Standard_RAGZRS`).
 *
 * Binding grants a custom role with only `blobServices/read`, assigned on
 * the bound storage account (an account-level operation has no narrower
 * scope). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host gets an Entra
 * service principal with the role and its client secret in the host's env
 * (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link GetBlobServiceStatisticsHttp}.
 *
 * ### Reading Replication Status
 * **Example:** Read the last sync time
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const getBlobServiceStatistics = yield* Azure.Storage.GetBlobServiceStatistics(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         const stats = yield* getBlobServiceStatistics();
 *         const lastSync = stats.GeoReplication?.LastSyncTime;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetBlobServiceStatisticsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetBlobServiceStatistics extends Binding.Service<
  GetBlobServiceStatistics,
  "Azure.Storage.GetBlobServiceStatistics",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: GetBlobServiceStatisticsRequest,
    ) => Effect.Effect<
      blob.GetServiceStatisticsResponse,
      blob.GetServiceStatisticsError,
      RuntimeContext
    >
  >
> {}

export const GetBlobServiceStatistics = Binding.Service<GetBlobServiceStatistics>(
  "Azure.Storage.GetBlobServiceStatistics",
);
