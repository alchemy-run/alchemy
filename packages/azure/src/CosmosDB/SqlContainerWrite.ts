import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { CreateDocumentClient } from "./CreateDocument.ts";
import type { DeleteDocumentClient } from "./DeleteDocument.ts";
import type { PatchDocumentClient } from "./PatchDocument.ts";
import type { ReplaceDocumentClient } from "./ReplaceDocument.ts";
import type { SqlContainer } from "./SqlContainer.ts";
import type { UpsertDocumentClient } from "./UpsertDocument.ts";

/** Write-only client for one Cosmos DB for NoSQL container. */
export interface WriteSqlContainerClient {
  /** Create a document ({@link CreateDocumentClient}). */
  create: CreateDocumentClient;
  /** Create or replace a document ({@link UpsertDocumentClient}). */
  upsert: UpsertDocumentClient;
  /** Replace a whole document ({@link ReplaceDocumentClient}). */
  replace: ReplaceDocumentClient;
  /** Change parts of a document ({@link PatchDocumentClient}). */
  patch: PatchDocumentClient;
  /** Delete a document ({@link DeleteDocumentClient}). */
  delete: DeleteDocumentClient;
}

/**
 * Write access to the documents of a Cosmos DB for NoSQL container from any
 * host: create, upsert, replace, patch, and delete, without reads.
 *
 * Binding assigns the host's Entra principal a custom Cosmos DB data-plane
 * role with `readMetadata`, `items/create`, `items/upsert`, `items/replace`,
 * and `items/delete` on the container only (`/dbs/{db}/colls/{container}`):
 * one `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every
 * host, and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an
 * Azure Function, Function App, Web App, Container App, container group, or
 * VM (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link SqlContainerWriteHttp}.
 *
 * ### Writing Documents
 * **Example:** Record an order and mark it paid
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const orders = yield* Azure.CosmosDB.SqlContainerWrite(ordersContainer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* orders.upsert({
 *           document: { id: "o-1", tenant: "t1", status: "open" },
 *           partitionKey: ["t1"],
 *         });
 *         yield* orders.patch({
 *           documentId: "o-1",
 *           partitionKey: ["t1"],
 *           operations: [{ op: "set", path: "/status", value: "paid" }],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.SqlContainerWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** Delete a document
 * ```typescript
 * yield* orders.delete({ documentId: "o-1", partitionKey: ["t1"] });
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface SqlContainerWrite extends Binding.Service<
  SqlContainerWrite,
  "Azure.CosmosDB.SqlContainerWrite",
  (container: SqlContainer) => Effect.Effect<WriteSqlContainerClient>
> {}

export const SqlContainerWrite = Binding.Service<SqlContainerWrite>(
  "Azure.CosmosDB.SqlContainerWrite",
);
