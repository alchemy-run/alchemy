import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `DeleteTable` request without the endpoint the bound account supplies. */
export interface DeleteTableRequest extends Omit<tables.DeleteTableRequest, "url"> {}

/**
 * Delete a table of an Azure Storage account at runtime.
 *
 * Binding assigns a custom role with only the `tableServices/tables/delete`
 * action on the storage account. The role is one
 * `Azure.Authorization.RoleDefinition` per stack,
 * `AzureStorageDeleteTableRole`, shared by every host.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link DeleteTableHttp}.
 *
 * A missing table fails with `TableNotFound`.
 *
 * ### Deleting Tables
 * **Example:** Drop a tenant's table
 * ```typescript
 * const Data = Azure.Storage.StorageAccount("Data");
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: bind the operation (assigns the role)
 *     const deleteTable = yield* Azure.Storage.DeleteTable(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteTable({ table: `tenant${tenantId}` });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DeleteTableHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteTable extends Binding.Service<
  DeleteTable,
  "Azure.Storage.DeleteTable",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request: DeleteTableRequest,
    ) => Effect.Effect<tables.DeleteTableResponse, tables.DeleteTableError, RuntimeContext>
  >
> {}

export const DeleteTable = Binding.Service<DeleteTable>("Azure.Storage.DeleteTable");
