import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GetTableEntityRequest } from "../Storage/GetTableEntity.ts";
import type { Table } from "./Table.ts";

/**
 * Read one entity of an Azure Cosmos DB for Table table by its PartitionKey
 * and RowKey.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata`
 * and `tables/containers/entities/read` on the table only (the built-in
 * Data Reader also queries and reads the change feed).
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link GetTableEntityHttp}.
 *
 * A missing entity fails with `TableEntityNotFound`.
 *
 * ### Reading an Entity
 * **Example:** Read a session
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
 *     const getSession = yield* Azure.CosmosDB.GetTableEntity(sessions);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const session = yield* getSession({ partitionKey: "sessions", rowKey: sessionId });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.GetTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface GetTableEntity extends Binding.Service<
  GetTableEntity,
  "Azure.CosmosDB.GetTableEntity",
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

export const GetTableEntity = Binding.Service<GetTableEntity>("Azure.CosmosDB.GetTableEntity");
