import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

/** A document to index, under `id` or, without one, under an id OpenSearch generates. */
export type IndexDocumentRequest = data.IndexDocumentRequest | data.AddDocumentRequest;

/**
 * Runtime binding for OpenSearch's `/{index}/_doc`: create or replace a document. With
 * `id` it writes that document, and `op_type: "create"` or `if_seq_no` make a clash fail
 * with `VersionConflict`. Without `id`, OpenSearch generates one.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link IndexDocumentHttp}.
 *
 * Calls authenticate with the credential's user, so this grants no STACKIT role. STACKIT
 * has no narrower user to bind, so the credential can do everything on the instance:
 * the limit here is the client's surface, not a permission. The host's egress IP has
 * to be in the instance's `acl`, or it can't connect.
 *
 * ### Indexing a Document
 * **Example:** Write a document from a Cloudflare Worker
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
 *     const indexDocument = yield* Stackit.OpenSearch.IndexDocument(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const written = yield* indexDocument({
 *           index: "orders",
 *           id: "1",
 *           refresh: "wait_for",
 *           body: { sku: "tea", quantity: 2 },
 *         });
 *         return yield* HttpServerResponse.json({ result: written.result });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.IndexDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface IndexDocument extends Binding.Service<
  IndexDocument,
  "Stackit.OpenSearch.IndexDocument",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: IndexDocumentRequest,
    ) => Effect.Effect<
      data.WriteResponse,
      data.IndexDocumentError | data.AddDocumentError,
      RuntimeContext
    >
  >
> {}

export const IndexDocument = Binding.Service<IndexDocument>("Stackit.OpenSearch.IndexDocument");
