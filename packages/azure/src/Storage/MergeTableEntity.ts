import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";

/** `MergeTableEntity` request without the endpoint and table the bound table supplies. */
export interface MergeTableEntityRequest extends Omit<
  tables.MergeTableEntityRequest,
  "url" | "table"
> {}

/**
 * Merge properties into an entity of an Azure Table storage table (Merge
 * Entity), or insert it when it does not exist and no `ifMatch` is given
 * (Insert Or Merge Entity).
 *
 * Binding assigns a custom role with only the `tables/entities/add/action`
 * and `tables/entities/update/action` data actions on the table (both are
 * needed to insert-or-merge). The role is one
 * `Azure.Authorization.RoleDefinition` per stack,
 * `AzureStorageTableUpsertEntityRole`, shared with {@link
 * UpdateTableEntity}.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link MergeTableEntityHttp}.
 *
 * Properties not in `body` keep their values. Pass `ifMatch` to merge only
 * into an existing entity; a stale ETag fails with
 * `TableEntityConditionNotMet`.
 *
 * ### Merging Entities
 * **Example:** Set one property
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
 *     const mergeProfile = yield* Azure.Storage.MergeTableEntity(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* mergeProfile({
 *           partitionKey: "users",
 *           rowKey: userId,
 *           ifMatch: "*",
 *           body: { lastSeen: new Date().toISOString() },
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.MergeTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface MergeTableEntity extends Binding.Service<
  MergeTableEntity,
  "Azure.Storage.MergeTableEntity",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: MergeTableEntityRequest,
    ) => Effect.Effect<
      tables.MergeTableEntityResponse,
      tables.MergeTableEntityError,
      RuntimeContext
    >
  >
> {}

export const MergeTableEntity = Binding.Service<MergeTableEntity>("Azure.Storage.MergeTableEntity");
