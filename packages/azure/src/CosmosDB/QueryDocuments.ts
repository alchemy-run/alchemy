import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `QueryDocuments` request; the bound container supplies the account, database, and container. */
export interface QueryDocumentsRequest extends Omit<
  cosmos.QueryDocumentsRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link QueryDocuments}. */
export type QueryDocumentsClient = (
  request: QueryDocumentsRequest,
) => Effect.Effect<cosmos.QueryDocumentsResponse, cosmos.QueryDocumentsError, RuntimeContext>;

/**
 * Run a parameterized SQL query over a Cosmos DB for NoSQL container one page at a time. Without a `partitionKey`, set `enableCrossPartition: true`.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata`, `executeQuery`, and `readChangeFeed` on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link QueryDocumentsHttp}.
 *
 * ### Querying Documents
 * **Example:** Query one partition
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const queryOrders = yield* Azure.CosmosDB.QueryDocuments(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         const { Documents } = yield* queryOrders({
 *           query: "SELECT * FROM c WHERE c.status = @status",
 *           parameters: [{ name: "@status", value: "open" }],
 *           partitionKey: ["t1"],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.QueryDocumentsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface QueryDocuments extends Binding.Service<
  QueryDocuments,
  "Azure.CosmosDB.QueryDocuments",
  (container: SqlContainer) => Effect.Effect<QueryDocumentsClient>
> {}

export const QueryDocuments = Binding.Service<QueryDocuments>("Azure.CosmosDB.QueryDocuments");
