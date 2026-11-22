import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { GetDocumentClient } from "./GetDocument.ts";
import type { ListDocumentsClient } from "./ListDocuments.ts";
import type { QueryDocumentsClient } from "./QueryDocuments.ts";
import type { SqlContainer } from "./SqlContainer.ts";

/** Read-only client for one Cosmos DB for NoSQL container. */
export interface ReadSqlContainerClient {
  /** Read one document by id and partition key ({@link GetDocumentClient}). */
  get: GetDocumentClient;
  /** List one page of documents, or of the change feed ({@link ListDocumentsClient}). */
  list: ListDocumentsClient;
  /** Run one page of a SQL query ({@link QueryDocumentsClient}). */
  query: QueryDocumentsClient;
}

/**
 * Read access to the documents of a Cosmos DB for NoSQL container from any
 * host: point reads, lists, change-feed reads, and SQL queries.
 *
 * Binding assigns the host's Entra principal the **Cosmos DB Built-in Data
 * Reader** data-plane role (`readMetadata`, `items/read`, `executeQuery`,
 * `readChangeFeed`) on the container only (`/dbs/{db}/colls/{container}`),
 * with one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link SqlContainerReadHttp}.
 *
 * ### Reading Documents
 * **Example:** Read an order and query its partition
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const orders = yield* Azure.CosmosDB.SqlContainerRead(ordersContainer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const { document } = yield* orders.get({ documentId: "o-1", partitionKey: ["t1"] });
 *         const { Documents } = yield* orders.query({
 *           query: "SELECT * FROM c WHERE c.status = @status",
 *           parameters: [{ name: "@status", value: "open" }],
 *           partitionKey: ["t1"],
 *         });
 *         return yield* HttpServerResponse.json({ document, open: Documents?.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.SqlContainerReadHttp)),
 * ) {}
 * ```
 *
 * **Example:** Page through a partition
 * ```typescript
 * const first = yield* orders.list({ partitionKey: ["t1"], maxItemCount: 100 });
 * const second = first.continuation
 *   ? yield* orders.list({ partitionKey: ["t1"], continuation: first.continuation })
 *   : undefined;
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface SqlContainerRead extends Binding.Service<
  SqlContainerRead,
  "Azure.CosmosDB.SqlContainerRead",
  (container: SqlContainer) => Effect.Effect<ReadSqlContainerClient>
> {}

export const SqlContainerRead = Binding.Service<SqlContainerRead>(
  "Azure.CosmosDB.SqlContainerRead",
);
