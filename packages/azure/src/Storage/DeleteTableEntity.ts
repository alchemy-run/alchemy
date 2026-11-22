import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";

/** `DeleteTableEntity` request without the endpoint and table the bound table supplies. */
export interface DeleteTableEntityRequest extends Omit<
  tables.DeleteTableEntityRequest,
  "url" | "table"
> {}

/**
 * Delete an entity from an Azure Table storage table.
 *
 * Binding assigns a custom role with only the `tables/entities/delete` data
 * action on the table. The role is one `Azure.Authorization.RoleDefinition`
 * per stack, `AzureStorageTableDeleteEntityRole`, shared by every host.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link DeleteTableEntityHttp}.
 *
 * `ifMatch: "*"` deletes unconditionally; a missing entity fails with
 * `TableEntityNotFound`.
 *
 * ### Deleting Entities
 * **Example:** Delete an order
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
 *     const deleteOrder = yield* Azure.Storage.DeleteTableEntity(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteOrder({ partitionKey: "orders", rowKey: orderId, ifMatch: "*" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DeleteTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteTableEntity extends Binding.Service<
  DeleteTableEntity,
  "Azure.Storage.DeleteTableEntity",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: DeleteTableEntityRequest,
    ) => Effect.Effect<
      tables.DeleteTableEntityResponse,
      tables.DeleteTableEntityError,
      RuntimeContext
    >
  >
> {}

export const DeleteTableEntity = Binding.Service<DeleteTableEntity>(
  "Azure.Storage.DeleteTableEntity",
);
