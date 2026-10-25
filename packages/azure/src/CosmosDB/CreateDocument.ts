import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `CreateDocument` request; the bound container supplies the account, database, and container. */
export interface CreateDocumentRequest extends Omit<
  cosmos.CreateDocumentRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link CreateDocument}. */
export type CreateDocumentClient = (
  request: CreateDocumentRequest,
) => Effect.Effect<cosmos.CreateDocumentResponse, cosmos.CreateDocumentError, RuntimeContext>;

/**
 * Create a document in a Cosmos DB for NoSQL container. Fails with `CosmosConflict` when a document with the same id already exists in the partition.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata` and `items/create` on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link CreateDocumentHttp}.
 *
 * ### Creating Documents
 * **Example:** Create an order
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const createOrder = yield* Azure.CosmosDB.CreateDocument(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         const { etag } = yield* createOrder({
 *           document: { id: orderId, tenant: "t1", total: 42 },
 *           partitionKey: ["t1"],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.CreateDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface CreateDocument extends Binding.Service<
  CreateDocument,
  "Azure.CosmosDB.CreateDocument",
  (container: SqlContainer) => Effect.Effect<CreateDocumentClient>
> {}

export const CreateDocument = Binding.Service<CreateDocument>("Azure.CosmosDB.CreateDocument");
