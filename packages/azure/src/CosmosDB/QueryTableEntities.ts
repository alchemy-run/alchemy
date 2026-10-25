import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { QueryTableEntitiesRequest } from "../Storage/QueryTableEntities.ts";
import type { Table } from "./Table.ts";

/**
 * Query the entities of an Azure Cosmos DB for Table table with an OData
 * filter.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata` and
 * `tables/containers/executeQuery` on the table only.
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link QueryTableEntitiesHttp}.
 *
 * One call returns one page; pass `xMsContinuationNextPartitionKey` /
 * `xMsContinuationNextRowKey` back as `NextPartitionKey` / `NextRowKey` for
 * the next one.
 *
 * ### Querying Entities
 * **Example:** Read one partition
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
 *     const querySessions = yield* Azure.CosmosDB.QueryTableEntities(sessions);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* querySessions({ _filter: "PartitionKey eq 'sessions'" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.QueryTableEntitiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface QueryTableEntities extends Binding.Service<
  QueryTableEntities,
  "Azure.CosmosDB.QueryTableEntities",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: QueryTableEntitiesRequest,
    ) => Effect.Effect<
      tables.TableEntityQueryResponse,
      tables.TableQueryEntitiesError,
      RuntimeContext
    >
  >
> {}

export const QueryTableEntities = Binding.Service<QueryTableEntities>(
  "Azure.CosmosDB.QueryTableEntities",
);
