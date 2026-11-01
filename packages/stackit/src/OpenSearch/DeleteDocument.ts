import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface DeleteDocumentRequest extends data.DeleteDocumentRequest {}

/**
 * Runtime binding for OpenSearch's `DELETE /{index}/_doc/{id}`: remove a document. A
 * missing document fails with `DocumentNotFound`, a missing index with `IndexNotFound`.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link DeleteDocumentHttp}.
 *
 * Calls authenticate with the credential's user, so this grants no STACKIT role. STACKIT
 * has no narrower user to bind, so the credential can do everything on the instance:
 * the limit here is the client's surface, not a permission. The host's egress IP has
 * to be in the instance's `acl`, or it can't connect.
 *
 * ### Deleting a Document
 * **Example:** Delete a document from a Cloudflare Worker
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
 *     const deleteDocument = yield* Stackit.OpenSearch.DeleteDocument(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const deleted = yield* deleteDocument({ index: "orders", id: "1" });
 *         return yield* HttpServerResponse.json({ result: deleted.result });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.DeleteDocumentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface DeleteDocument extends Binding.Service<
  DeleteDocument,
  "Stackit.OpenSearch.DeleteDocument",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: DeleteDocumentRequest,
    ) => Effect.Effect<data.WriteResponse, data.DeleteDocumentError, RuntimeContext>
  >
> {}

export const DeleteDocument = Binding.Service<DeleteDocument>("Stackit.OpenSearch.DeleteDocument");
