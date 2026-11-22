import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InsertTableEntityRequest } from "../Storage/InsertTableEntity.ts";
import type { Table } from "./Table.ts";

/**
 * Insert a new entity into an Azure Cosmos DB for Table table.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata` and
 * `tables/containers/entities/create` on the table only.
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link InsertTableEntityHttp}.
 *
 * An entity with the same keys fails with `TableEntityAlreadyExists`.
 *
 * ### Inserting Entities
 * **Example:** Record a session
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
 *     const insertSession = yield* Azure.CosmosDB.InsertTableEntity(sessions);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* insertSession({ body: { PartitionKey: "sessions", RowKey: sessionId, user } });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.InsertTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface InsertTableEntity extends Binding.Service<
  InsertTableEntity,
  "Azure.CosmosDB.InsertTableEntity",
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
  "Azure.CosmosDB.InsertTableEntity",
);
