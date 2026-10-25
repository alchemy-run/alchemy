import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `CreateTable` request without the endpoint the bound account supplies. */
export interface CreateTableRequest extends Omit<tables.CreateTableRequest, "url"> {}

/**
 * Create a table in an Azure Storage account at runtime.
 *
 * Binding assigns a custom role with only the `tableServices/tables/write`
 * action on the storage account (tables created at runtime have no ARM scope
 * beforehand). The role is one `Azure.Authorization.RoleDefinition` per
 * stack, `AzureStorageCreateTableRole`, shared by every host.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link CreateTableHttp}.
 *
 * An existing name fails with `TableAlreadyExists`; a name still being
 * deleted fails with `TableBeingDeleted`. Declare long-lived tables with
 * `Azure.Storage.Table` instead.
 *
 * ### Creating Tables
 * **Example:** Create a table per tenant
 * ```typescript
 * const Data = Azure.Storage.StorageAccount("Data");
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: bind the operation (assigns the role)
 *     const createTable = yield* Azure.Storage.CreateTable(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* createTable({ TableName: `tenant${tenantId}` });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CreateTableHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateTable extends Binding.Service<
  CreateTable,
  "Azure.Storage.CreateTable",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request: CreateTableRequest,
    ) => Effect.Effect<tables.TableResponse, tables.CreateTableError, RuntimeContext>
  >
> {}

export const CreateTable = Binding.Service<CreateTable>("Azure.Storage.CreateTable");
