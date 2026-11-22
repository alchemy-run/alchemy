import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";

/** `TableQueryEntityWithPartitionAndRowKey` request without the endpoint and table the bound table supplies. */
export interface GetTableEntityRequest extends Omit<
  tables.TableQueryEntityWithPartitionAndRowKeyRequest,
  "url" | "table"
> {}

/**
 * Read one entity of an Azure Table storage table by its PartitionKey and
 * RowKey.
 *
 * Binding assigns **Storage Table Data Reader** on the table only (data
 * action `tables/entities/read`).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link GetTableEntityHttp}.
 *
 * A missing entity fails with `TableEntityNotFound`.
 *
 * ### Reading an Entity
 * **Example:** Read an order
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
 *     const getOrder = yield* Azure.Storage.GetTableEntity(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const order = yield* getOrder({ partitionKey: "orders", rowKey: orderId });
 *         const total = order.total;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetTableEntity extends Binding.Service<
  GetTableEntity,
  "Azure.Storage.GetTableEntity",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: GetTableEntityRequest,
    ) => Effect.Effect<
      tables.TableQueryEntityWithPartitionAndRowKeyResponse,
      tables.TableQueryEntityWithPartitionAndRowKeyError,
      RuntimeContext
    >
  >
> {}

export const GetTableEntity = Binding.Service<GetTableEntity>("Azure.Storage.GetTableEntity");
