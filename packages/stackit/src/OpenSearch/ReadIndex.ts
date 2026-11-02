import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface ReadIndexClient {
  /** Run a query. */
  search: (
    request: data.SearchRequest,
  ) => Effect.Effect<data.SearchResponse, data.SearchError, RuntimeContext>;
  /** Read a document by id. */
  get: (
    request: data.GetDocumentRequest,
  ) => Effect.Effect<data.GetDocumentResponse, data.GetDocumentError, RuntimeContext>;
}

/**
 * Bind a {@link Credential} to the read half of the REST API: `search` and `get`. Each request names its index. Provide
 * {@link ReadIndexHttp}.
 *
 * The access levels differ only in API surface. A STACKIT credential isn't scoped by
 * this API, so `ReadIndex`, `WriteIndex` and `ReadWriteIndex` hold the same user: pick
 * the one that says what the host does.
 *
 * Calls authenticate with the credential's user, so this grants no STACKIT role. STACKIT
 * has no narrower user to bind, so the credential can do everything on the instance:
 * the limit here is the client's surface, not a permission. The host's egress IP has
 * to be in the instance's `acl`, or it can't connect.
 *
 * ### Using the Client
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Search = Stackit.OpenSearch.Instance("Search", {
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Search.pipe(
 *   Effect.flatMap((search) =>
 *     Stackit.OpenSearch.Credential("App", { instanceId: search.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const orders = yield* Stackit.OpenSearch.ReadIndex(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const found = yield* orders.search({ index: "orders", size: 10 });
 *         return yield* HttpServerResponse.json({ hits: found.hits.hits.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.ReadIndexHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface ReadIndex extends Binding.Service<
  ReadIndex,
  "Stackit.OpenSearch.ReadIndex",
  (credential: Credential) => Effect.Effect<ReadIndexClient>
> {}

export const ReadIndex = Binding.Service<ReadIndex>("Stackit.OpenSearch.ReadIndex");
