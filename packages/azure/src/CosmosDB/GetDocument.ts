import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `GetDocument` request; the bound container supplies the account, database, and container. */
export interface GetDocumentRequest extends Omit<
  cosmos.GetDocumentRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link GetDocument}. */
export type GetDocumentClient = (
  request: GetDocumentRequest,
) => Effect.Effect<cosmos.GetDocumentResponse, cosmos.GetDocumentError, RuntimeContext>;

/**
 * Read one document (a point read by id and partition key) from a Cosmos DB for NoSQL container. Fails with `CosmosNotFound` when it does not exist.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata` and `items/read` on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link GetDocumentHttp}.
 *
 * ### Reading Documents
 * **Example:** Read an order
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const getOrder = yield* Azure.CosmosDB.GetDocument(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         const { document } = yield* getOrder({ documentId: orderId, partitionKey: ["t1"] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.GetDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface GetDocument extends Binding.Service<
  GetDocument,
  "Azure.CosmosDB.GetDocument",
  (container: SqlContainer) => Effect.Effect<GetDocumentClient>
> {}

export const GetDocument = Binding.Service<GetDocument>("Azure.CosmosDB.GetDocument");
