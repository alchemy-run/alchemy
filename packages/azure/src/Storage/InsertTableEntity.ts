import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";

/** `InsertTableEntity` request without the endpoint and table the bound table supplies. */
export interface InsertTableEntityRequest extends Omit<
  tables.InsertTableEntityRequest,
  "url" | "table"
> {}

/**
 * Insert a new entity into an Azure Table storage table.
 *
 * Binding assigns a custom role with only the `tables/entities/add/action`
 * data action on the table (the built-in Storage Table Data Contributor also
 * reads, updates, and deletes). The role is one
 * `Azure.Authorization.RoleDefinition` per stack,
 * `AzureStorageTableInsertEntityRole`, shared by every host.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link InsertTableEntityHttp}.
 *
 * An entity with the same keys fails with `TableEntityAlreadyExists`.
 *
 * ### Inserting Entities
 * **Example:** Record an order
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
 *     const insertOrder = yield* Azure.Storage.InsertTableEntity(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* insertOrder({ body: { PartitionKey: "orders", RowKey: orderId, total: 42 } });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.InsertTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface InsertTableEntity extends Binding.Service<
  InsertTableEntity,
  "Azure.Storage.InsertTableEntity",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: InsertTableEntityRequest,
    ) => Effect.Effect<
      tables.InsertTableEntityResponse,
      tables.InsertTableEntityError,
      RuntimeContext
    >
  >
> {}

export const InsertTableEntity = Binding.Service<InsertTableEntity>(
  "Azure.Storage.InsertTableEntity",
);
