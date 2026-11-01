import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BulkRequest } from "./Bulk.ts";
import type { Credential } from "./Credential.ts";
import type { IndexDocumentRequest } from "./IndexDocument.ts";

export interface WriteIndexClient {
  /** Create or replace a document, under an id OpenSearch generates without `id`. */
  index: (
    request: IndexDocumentRequest,
  ) => Effect.Effect<
    data.WriteResponse,
    data.IndexDocumentError | data.AddDocumentError,
    RuntimeContext
  >;
  /** Remove a document. */
  delete: (
    request: data.DeleteDocumentRequest,
  ) => Effect.Effect<data.WriteResponse, data.DeleteDocumentError, RuntimeContext>;
  /** Run many actions in one request. A failed action doesn't fail the request. */
  bulk: (request: BulkRequest) => Effect.Effect<data.BulkResponse, data.BulkError, RuntimeContext>;
}

/**
 * Bind a {@link Credential} to the write half of the REST API: `index`, `delete` and `bulk`. Each request names its index. Provide
 * {@link WriteIndexHttp}.
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
 *     const orders = yield* Stackit.OpenSearch.WriteIndex(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const written = yield* orders.index({ index: "orders", body: { sku: "tea" } });
 *         return yield* HttpServerResponse.json({ id: written._id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.WriteIndexHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface WriteIndex extends Binding.Service<
  WriteIndex,
  "Stackit.OpenSearch.WriteIndex",
  (credential: Credential) => Effect.Effect<WriteIndexClient>
> {}

export const WriteIndex = Binding.Service<WriteIndex>("Stackit.OpenSearch.WriteIndex");
