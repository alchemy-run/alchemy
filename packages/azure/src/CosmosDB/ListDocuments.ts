import type * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

/** A `ListDocuments` request; the bound container supplies the account, database, and container. */
export interface ListDocumentsRequest extends Omit<
  cosmos.ListDocumentsRequest,
  "accountName" | "databaseId" | "collectionId"
> {}

/** Runtime callable of {@link ListDocuments}. */
export type ListDocumentsClient = (
  request?: ListDocumentsRequest,
) => Effect.Effect<cosmos.ListDocumentsResponse, cosmos.ListDocumentsError, RuntimeContext>;

/**
 * List the documents of a Cosmos DB for NoSQL container one page at a time (`continuation` pages on), or read its change feed with `aIm: "Incremental feed"`.
 *
 * Binding assigns the host's Entra principal a custom role with `readMetadata` and `readChangeFeed` on the container only
 * (`/dbs/{db}/colls/{container}`), as a Cosmos DB data-plane role: one
 * `Azure.CosmosDB.SqlRoleDefinition` per container, shared by every host,
 * and one `Azure.CosmosDB.SqlRoleAssignment` per host. The host is an Azure
 * Function, Function App, Web App, Container App, container group, or VM
 * (its managed identity), or any other host, which gets an Entra service
 * principal and client secret (see `AzureBindings`). Provide
 * {@link ListDocumentsHttp}.
 *
 * ### Listing Documents
 * **Example:** List one partition
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the data role on the container
 *     const listOrders = yield* Azure.CosmosDB.ListDocuments(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account, database, and container are filled in
 *         const page = yield* listOrders({ partitionKey: ["t1"], maxItemCount: 100 });
 *         const next = page.continuation
 *           ? yield* listOrders({ partitionKey: ["t1"], continuation: page.continuation })
 *           : undefined;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.ListDocumentsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface ListDocuments extends Binding.Service<
  ListDocuments,
  "Azure.CosmosDB.ListDocuments",
  (container: SqlContainer) => Effect.Effect<ListDocumentsClient>
> {}

export const ListDocuments = Binding.Service<ListDocuments>("Azure.CosmosDB.ListDocuments");
