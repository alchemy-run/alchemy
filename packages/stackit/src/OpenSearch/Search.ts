import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface SearchRequest extends data.SearchRequest {}

/**
 * Runtime binding for OpenSearch's `_search`: run a query on an index, or on a
 * comma-separated list or wildcard pattern of them.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link SearchHttp}.
 *
 * Calls authenticate with the credential's user, so this grants no STACKIT role. STACKIT
 * has no narrower user to bind, so the credential can do everything on the instance:
 * the limit here is the client's surface, not a permission. The host's egress IP has
 * to be in the instance's `acl`, or it can't connect.
 *
 * ### Searching an Index
 * **Example:** A match query from a Cloudflare Worker
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
 *     const search = yield* Stackit.OpenSearch.Search(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const found = yield* search({ index: "orders", query: { match: { sku: "tea" } }, size: 10 });
 *         return yield* HttpServerResponse.json({ hits: found.hits.hits.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.SearchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface Search extends Binding.Service<
  Search,
  "Stackit.OpenSearch.Search",
  (
    credential: Credential,
  ) => Effect.Effect<
    (request: SearchRequest) => Effect.Effect<data.SearchResponse, data.SearchError, RuntimeContext>
  >
> {}

export const Search = Binding.Service<Search>("Stackit.OpenSearch.Search");
