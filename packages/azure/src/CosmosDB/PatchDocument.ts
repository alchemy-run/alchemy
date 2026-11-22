import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `PatchDocument` request; the bound container supplies the account, database, and container. */
export interface PatchDocumentRequest extends Omit<
  cosmos.PatchDocumentRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link PatchDocument}. */
export type PatchDocumentClient = (
  request: PatchDocumentRequest,
) => Effect.Effect<cosmos.PatchDocumentResponse, cosmos.PatchDocumentError, RuntimeContext>;

/**
 * Change parts of a document in a Cosmos DB for NoSQL container with up to 10 patch operations (`set`, `add`, `replace`, `remove`, `incr`, `move`), optionally only when a `condition` matches.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata` and `items/replace` (Cosmos DB checks `replace` for a patch) on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link PatchDocumentHttp}.
 *
 * ### Patching Documents
 * **Example:** Mark an order shipped
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const patchOrder = yield* Azure.CosmosDB.PatchDocument(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         yield* patchOrder({
 *           documentId: orderId,
 *           partitionKey: ["t1"],
 *           operations: [{ op: "set", path: "/status", value: "shipped" }],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.PatchDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface PatchDocument extends Binding.Service<
  PatchDocument,
  "Azure.CosmosDB.PatchDocument",
  (container: SqlContainer) => Effect.Effect<PatchDocumentClient>
> {}

export const PatchDocument = Binding.Service<PatchDocument>("Azure.CosmosDB.PatchDocument");
