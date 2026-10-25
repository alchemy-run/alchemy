import type * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { MergeTableEntityRequest } from "../Storage/MergeTableEntity.ts";
import type { Table } from "./Table.ts";

/**
 * Merge properties into an entity of an Azure Cosmos DB for Table table, or
 * insert it when it does not exist and no `ifMatch` is given.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata`
 * and `tables/containers/executeStoredProcedure` on the table only: Cosmos
 * DB runs a merge as the system stored procedure
 * `__.sys.tablesBatchOperation`.
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link MergeTableEntityHttp}.
 *
 * Properties not in `body` keep their values.
 *
 * ### Merging Entities
 * **Example:** Touch a session
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
 *     const mergeSession = yield* Azure.CosmosDB.MergeTableEntity(sessions);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* mergeSession({
 *           partitionKey: "sessions",
 *           rowKey: sessionId,
 *           ifMatch: "*",
 *           body: { lastSeen: new Date().toISOString() },
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.MergeTableEntityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface MergeTableEntity extends Binding.Service<
  MergeTableEntity,
  "Azure.CosmosDB.MergeTableEntity",
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

export const MergeTableEntity = Binding.Service<MergeTableEntity>(
  "Azure.CosmosDB.MergeTableEntity",
);
