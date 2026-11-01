import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";
import type { ReadIndexClient } from "./ReadIndex.ts";
import type { WriteIndexClient } from "./WriteIndex.ts";

export interface ReadWriteIndexClient extends ReadIndexClient, WriteIndexClient {}

/**
 * Bind a {@link Credential} to the whole REST API this provider models: `search`, `get`, `index`, `delete` and `bulk`. Each request names its index. Provide
 * {@link ReadWriteIndexHttp}.
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
 *     const orders = yield* Stackit.OpenSearch.ReadWriteIndex(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.index({ index: "orders", id: "1", refresh: "true", body: { sku: "tea" } });
 *         const order = yield* orders.get({ index: "orders", id: "1" });
 *         return yield* HttpServerResponse.json({ source: order._source });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.ReadWriteIndexHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface ReadWriteIndex extends Binding.Service<
  ReadWriteIndex,
  "Stackit.OpenSearch.ReadWriteIndex",
  (credential: Credential) => Effect.Effect<ReadWriteIndexClient>
> {}

export const ReadWriteIndex = Binding.Service<ReadWriteIndex>("Stackit.OpenSearch.ReadWriteIndex");
