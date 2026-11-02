import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface GetDocumentRequest extends data.GetDocumentRequest {}

/**
 * Runtime binding for OpenSearch's `GET /{index}/_doc/{id}`: read a document by id. A
 * missing document fails with `DocumentNotFound`, a missing index with `IndexNotFound`.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link GetDocumentHttp}.
 *
 * Calls authenticate with the credential's user, so this grants no STACKIT role. STACKIT
 * has no narrower user to bind, so the credential can do everything on the instance:
 * the limit here is the client's surface, not a permission. The host's egress IP has
 * to be in the instance's `acl`, or it can't connect.
 *
 * ### Reading a Document
 * **Example:** Read a document from a Cloudflare Worker
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
 *     const getDocument = yield* Stackit.OpenSearch.GetDocument(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const order = yield* getDocument({ index: "orders", id: "1" });
 *         return yield* HttpServerResponse.json({ source: order._source });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.GetDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface GetDocument extends Binding.Service<
  GetDocument,
  "Stackit.OpenSearch.GetDocument",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: GetDocumentRequest,
    ) => Effect.Effect<data.GetDocumentResponse, data.GetDocumentError, RuntimeContext>
  >
> {}

export const GetDocument = Binding.Service<GetDocument>("Stackit.OpenSearch.GetDocument");
