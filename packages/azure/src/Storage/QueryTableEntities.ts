import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";

/** `TableQueryEntities` request without the endpoint and table the bound table supplies. */
export interface QueryTableEntitiesRequest extends Omit<
  tables.TableQueryEntitiesRequest,
  "url" | "table"
> {}

/**
 * Query the entities of an Azure Table storage table with an OData filter.
 *
 * Binding assigns **Storage Table Data Reader** on the table only (data
 * action `tables/entities/read`).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link QueryTableEntitiesHttp}.
 *
 * One call returns one page; pass `xMsContinuationNextPartitionKey` /
 * `xMsContinuationNextRowKey` back as `NextPartitionKey` / `NextRowKey` for
 * the next one.
 *
 * ### Querying Entities
 * **Example:** Read one partition
 * ```typescript
 * const Orders = Effect.gen(function* () {
 *   const account = yield* Azure.Storage.StorageAccount("Data");
 *   return yield* Azure.Storage.Table("Orders", { storageAccount: account.storageAccountName });
 * });
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const orders = yield* Orders;
 *     // init: bind the operation (assigns the role)
 *     const queryOrders = yield* Azure.Storage.QueryTableEntities(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* queryOrders({ _filter: "PartitionKey eq 'orders'", _top: 100 });
 *         const next = page.xMsContinuationNextPartitionKey; // undefined on the last page
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.QueryTableEntitiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueryTableEntities extends Binding.Service<
  QueryTableEntities,
  "Azure.Storage.QueryTableEntities",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: QueryTableEntitiesRequest,
    ) => Effect.Effect<
      tables.TableQueryEntitiesResponse,
      tables.TableQueryEntitiesError,
      RuntimeContext
    >
  >
> {}

export const QueryTableEntities = Binding.Service<QueryTableEntities>(
  "Azure.Storage.QueryTableEntities",
);
