import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";
import type { ReadSqlContainerClient } from "./SqlContainerRead.ts";
import type { WriteSqlContainerClient } from "./SqlContainerWrite.ts";

/** Read and write client for one Cosmos DB for NoSQL container. */
export interface ReadWriteSqlContainerClient
  extends ReadSqlContainerClient, WriteSqlContainerClient {}

/**
 * Read and write access to the documents of a Cosmos DB for NoSQL container
 * from any host: point reads, lists, queries, create, upsert, replace,
 * patch, and delete.
 *
 * Binding assigns the host's Entra principal a custom Cosmos DB data-plane
 * role with `readMetadata`, `items/read`, `items/create`, `items/upsert`,
 * `items/replace`, `items/delete`, `executeQuery`, and `readChangeFeed` on
 * the container only (`/dbs/{db}/colls/{container}`). It is narrower than
 * the built-in Data Contributor, which also runs stored procedures, manages
 * conflicts, and unmasks data. There is one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link SqlContainerReadWriteHttp}.
 *
 * ### Reading and Writing Documents
 * **Example:** Optimistic read-modify-write
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const carts = yield* Azure.CosmosDB.SqlContainerReadWrite(cartsContainer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const { document, etag } = yield* carts.get({
 *           documentId: "c-1",
 *           partitionKey: ["u-1"],
 *         });
 *         const cart = document as { id: string; user: string; items: string[] };
 *         yield* carts.replace({
 *           documentId: cart.id,
 *           document: { ...cart, items: [...cart.items, "sku-9"] },
 *           partitionKey: [cart.user],
 *           ifMatch: etag,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.SqlContainerReadWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface SqlContainerReadWrite extends Binding.Service<
  SqlContainerReadWrite,
  "Azure.CosmosDB.SqlContainerReadWrite",
  (container: SqlContainer) => Effect.Effect<ReadWriteSqlContainerClient>
> {}

export const SqlContainerReadWrite = Binding.Service<SqlContainerReadWrite>(
  "Azure.CosmosDB.SqlContainerReadWrite",
);
