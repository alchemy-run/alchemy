import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeleteTableEntityRequest } from "../Storage/DeleteTableEntity.ts";
import type { Table } from "./Table.ts";

/**
 * Delete an entity from an Azure Cosmos DB for Table table.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata` and
 * `tables/containers/entities/delete` on the table only.
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link DeleteTableEntityHttp}.
 *
 * `ifMatch: "*"` deletes unconditionally; a missing entity fails with
 * `TableEntityNotFound`.
 *
 * ### Deleting Entities
 * **Example:** End a session
 * ```typescript
 * const Sessions = Effect.gen(function* () {
 *   const account = yield* Azure.CosmosDB.DatabaseAccount("Data", { capabilities: ["EnableTable"] });
 *   return yield* Azure.CosmosDB.Table("Sessions", { account: account.accountName });
 * });
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sessions = yield* Sessions;
 *     // init: bind the operation (assigns the data role)
 *     const deleteSession = yield* Azure.CosmosDB.DeleteTableEntity(sessions);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteSession({ partitionKey: "sessions", rowKey: sessionId, ifMatch: "*" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.DeleteTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface DeleteTableEntity extends Binding.Service<
  DeleteTableEntity,
  "Azure.CosmosDB.DeleteTableEntity",
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
  "Azure.CosmosDB.DeleteTableEntity",
);
