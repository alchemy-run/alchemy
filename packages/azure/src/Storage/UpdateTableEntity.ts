import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";

/** `UpdateTableEntity` request without the endpoint and table the bound table supplies. */
export interface UpdateTableEntityRequest extends Omit<
  tables.UpdateTableEntityRequest,
  "url" | "table"
> {}

/**
 * Replace an entity of an Azure Table storage table (Update Entity), or
 * insert it when it does not exist and no `ifMatch` is given (Insert Or
 * Replace Entity).
 *
 * Binding assigns a custom role with only the `tables/entities/add/action`
 * and `tables/entities/update/action` data actions on the table (both are
 * needed to insert-or-replace). The role is one
 * `Azure.Authorization.RoleDefinition` per stack,
 * `AzureStorageTableUpsertEntityRole`, shared with {@link MergeTableEntity}.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link UpdateTableEntityHttp}.
 *
 * Pass `ifMatch` (an ETag, or `*`) to replace only an existing entity; a
 * stale ETag fails with `TableEntityConditionNotMet`.
 *
 * ### Replacing Entities
 * **Example:** Insert or replace a profile
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
 *     const putProfile = yield* Azure.Storage.UpdateTableEntity(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putProfile({
 *           partitionKey: "users",
 *           rowKey: userId,
 *           body: { PartitionKey: "users", RowKey: userId, name },
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.UpdateTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UpdateTableEntity extends Binding.Service<
  UpdateTableEntity,
  "Azure.Storage.UpdateTableEntity",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: UpdateTableEntityRequest,
    ) => Effect.Effect<
      tables.UpdateTableEntityResponse,
      tables.UpdateTableEntityError,
      RuntimeContext
    >
  >
> {}

export const UpdateTableEntity = Binding.Service<UpdateTableEntity>(
  "Azure.Storage.UpdateTableEntity",
);
