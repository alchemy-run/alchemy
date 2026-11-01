import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface BulkRequest extends Omit<data.BulkRequest, "body"> {
  /**
   * The body's lines in order: each action, followed by its document for `index`,
   * `create` and `update`. Each one is written as one line of JSON.
   */
  lines: ReadonlyArray<unknown>;
}

/**
 * Runtime binding for OpenSearch's `_bulk`: run many index, create, update and delete
 * actions in one request. **A failed action doesn't fail the request**: check `errors`
 * on the answer, and each item's `error`.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link BulkHttp}.
 *
 * Calls authenticate with the credential's user, so this grants no STACKIT role. STACKIT
 * has no narrower user to bind, so the credential can do everything on the instance:
 * the limit here is the client's surface, not a permission. The host's egress IP has
 * to be in the instance's `acl`, or it can't connect.
 *
 * ### Writing Many Documents
 * **Example:** Index two documents and delete a third from a Cloudflare Worker
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
 *     const bulk = yield* Stackit.OpenSearch.Bulk(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const answer = yield* bulk({
 *           index: "orders",
 *           refresh: "wait_for",
 *           lines: [
 *             { index: { _id: "1" } },
 *             { sku: "tea" },
 *             { index: { _id: "2" } },
 *             { sku: "coffee" },
 *             { delete: { _id: "3" } },
 *           ],
 *         });
 *         return yield* HttpServerResponse.json({ failed: answer.errors });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.BulkHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface Bulk extends Binding.Service<
  Bulk,
  "Stackit.OpenSearch.Bulk",
  (
    credential: Credential,
  ) => Effect.Effect<
    (request: BulkRequest) => Effect.Effect<data.BulkResponse, data.BulkError, RuntimeContext>
  >
> {}

export const Bulk = Binding.Service<Bulk>("Stackit.OpenSearch.Bulk");
