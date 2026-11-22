import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { UpdateTableEntityRequest } from "../Storage/UpdateTableEntity.ts";
import type { Table } from "./Table.ts";

/**
 * Replace an entity of an Azure Cosmos DB for Table table, or insert it when
 * it does not exist and no `ifMatch` is given.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata`,
 * `tables/containers/entities/upsert`, and
 * `tables/containers/entities/replace` on the table only.
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link UpdateTableEntityHttp}.
 *
 * Pass `ifMatch` (an ETag, or `*`) to replace only an existing entity; a
 * stale ETag fails with `TableEntityConditionNotMet`.
 *
 * ### Replacing Entities
 * **Example:** Insert or replace a session
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
 *     const putSession = yield* Azure.CosmosDB.UpdateTableEntity(sessions);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putSession({
 *           partitionKey: "sessions",
 *           rowKey: sessionId,
 *           body: { PartitionKey: "sessions", RowKey: sessionId, user },
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.UpdateTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface UpdateTableEntity extends Binding.Service<
  UpdateTableEntity,
  "Azure.CosmosDB.UpdateTableEntity",
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
  "Azure.CosmosDB.UpdateTableEntity",
);
