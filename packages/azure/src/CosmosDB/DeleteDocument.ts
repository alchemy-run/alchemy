import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `DeleteDocument` request; the bound container supplies the account, database, and container. */
export interface DeleteDocumentRequest extends Omit<
  cosmos.DeleteDocumentRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link DeleteDocument}. */
export type DeleteDocumentClient = (
  request: DeleteDocumentRequest,
) => Effect.Effect<cosmos.DeleteDocumentResponse, cosmos.DeleteDocumentError, RuntimeContext>;

/**
 * Delete a document from a Cosmos DB for NoSQL container. Fails with `CosmosNotFound` when it does not exist.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata` and `items/delete` on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link DeleteDocumentHttp}.
 *
 * ### Deleting Documents
 * **Example:** Delete an order
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const deleteOrder = yield* Azure.CosmosDB.DeleteDocument(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         yield* deleteOrder({ documentId: orderId, partitionKey: ["t1"] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.DeleteDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface DeleteDocument extends Binding.Service<
  DeleteDocument,
  "Azure.CosmosDB.DeleteDocument",
  (container: SqlContainer) => Effect.Effect<DeleteDocumentClient>
> {}

export const DeleteDocument = Binding.Service<DeleteDocument>("Azure.CosmosDB.DeleteDocument");
