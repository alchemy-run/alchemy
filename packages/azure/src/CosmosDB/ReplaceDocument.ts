import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `ReplaceDocument` request; the bound container supplies the account, database, and container. */
export interface ReplaceDocumentRequest extends Omit<
  cosmos.ReplaceDocumentRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link ReplaceDocument}. */
export type ReplaceDocumentClient = (
  request: ReplaceDocumentRequest,
) => Effect.Effect<cosmos.ReplaceDocumentResponse, cosmos.ReplaceDocumentError, RuntimeContext>;

/**
 * Replace a whole document in a Cosmos DB for NoSQL container; pass `ifMatch` for optimistic concurrency. Fails with `CosmosNotFound` when it does not exist.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata` and `items/replace` on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link ReplaceDocumentHttp}.
 *
 * ### Replacing Documents
 * **Example:** Replace an order if unchanged
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const replaceOrder = yield* Azure.CosmosDB.ReplaceDocument(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         yield* replaceOrder({
 *           documentId: orderId,
 *           document: { id: orderId, tenant: "t1", total: 50 },
 *           partitionKey: ["t1"],
 *           ifMatch: etag,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.ReplaceDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface ReplaceDocument extends Binding.Service<
  ReplaceDocument,
  "Azure.CosmosDB.ReplaceDocument",
  (container: SqlContainer) => Effect.Effect<ReplaceDocumentClient>
> {}

export const ReplaceDocument = Binding.Service<ReplaceDocument>("Azure.CosmosDB.ReplaceDocument");
