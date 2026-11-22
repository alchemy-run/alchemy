import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `UpsertDocument` request; the bound container supplies the account, database, and container. */
export interface UpsertDocumentRequest extends Omit<
  cosmos.UpsertDocumentRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link UpsertDocument}. */
export type UpsertDocumentClient = (
  request: UpsertDocumentRequest,
) => Effect.Effect<cosmos.UpsertDocumentResponse, cosmos.UpsertDocumentError, RuntimeContext>;

/**
 * Create a document in a Cosmos DB for NoSQL container, or replace the one with the same id.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata` and `items/upsert` on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link UpsertDocumentHttp}.
 *
 * ### Upserting Documents
 * **Example:** Upsert an order
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const upsertOrder = yield* Azure.CosmosDB.UpsertDocument(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         yield* upsertOrder({
 *           document: { id: orderId, tenant: "t1", total: 42 },
 *           partitionKey: ["t1"],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.UpsertDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface UpsertDocument extends Binding.Service<
  UpsertDocument,
  "Azure.CosmosDB.UpsertDocument",
  (container: SqlContainer) => Effect.Effect<UpsertDocumentClient>
> {}

export const UpsertDocument = Binding.Service<UpsertDocument>("Azure.CosmosDB.UpsertDocument");
