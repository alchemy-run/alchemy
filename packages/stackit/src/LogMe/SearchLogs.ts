import type * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface SearchLogsRequest extends Omit<data.SearchRequest, "index"> {
  /**
   * Index name, comma-separated list or wildcard pattern to search.
   *
   * @default "*"
   */
  index?: string;
}

/**
 * Runtime binding for searching the logs of a LogMe instance, on the OpenSearch REST API
 * it serves. The request takes OpenSearch's search body.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link SearchLogsHttp}.
 *
 * Calls authenticate with the credential's user, so this grants no STACKIT role. The
 * host's egress IP has to be in the instance's `acl`, or it can't connect.
 *
 * ### Searching Logs
 * **Example:** Find recent errors from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Logs.pipe(
 *   Effect.flatMap((logs) => Stackit.LogMe.Credential("App", { instanceId: logs.instanceId })),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const searchLogs = yield* Stackit.LogMe.SearchLogs(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const found = yield* searchLogs({ query: { match: { message: "error" } }, size: 10 });
 *         return yield* HttpServerResponse.json({ hits: found.hits.hits.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.SearchLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface SearchLogs extends Binding.Service<
  SearchLogs,
  "Stackit.LogMe.SearchLogs",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: SearchLogsRequest,
    ) => Effect.Effect<data.SearchResponse, data.SearchError, RuntimeContext>
  >
> {}

export const SearchLogs = Binding.Service<SearchLogs>("Stackit.LogMe.SearchLogs");
