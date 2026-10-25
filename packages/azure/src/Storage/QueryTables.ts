import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `TableQuery` request without the endpoint the bound account supplies. */
export interface QueryTablesRequest extends Omit<tables.TableQueryRequest, "url"> {}

/**
 * List the tables of an Azure Storage account.
 *
 * Binding assigns a custom role with only the `tableServices/tables/read`
 * action on the storage account. The role is one
 * `Azure.Authorization.RoleDefinition` per stack,
 * `AzureStorageQueryTablesRole`, shared by every host.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link QueryTablesHttp}.
 *
 * One call returns one page; pass `xMsContinuationNextTableName` back as
 * `NextTableName` for the next one.
 *
 * ### Listing Tables
 * **Example:** List tenant tables
 * ```typescript
 * const Data = Azure.Storage.StorageAccount("Data");
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: bind the operation (assigns the role)
 *     const listTables = yield* Azure.Storage.QueryTables(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* listTables({ _filter: "TableName ge 'tenant' and TableName lt 'tenanu'" });
 *         const names = (page.value ?? []).map((t) => t.TableName);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.QueryTablesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueryTables extends Binding.Service<
  QueryTables,
  "Azure.Storage.QueryTables",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request: QueryTablesRequest,
    ) => Effect.Effect<tables.TableQueryResponse, tables.TableQueryError, RuntimeContext>
  >
> {}

export const QueryTables = Binding.Service<QueryTables>("Azure.Storage.QueryTables");
