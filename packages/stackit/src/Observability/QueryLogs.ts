import type * as loki from "@distilled.cloud/stackit/logs_loki";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";
import type { Instance } from "./Instance.ts";

/** The Loki query API of a bound instance. */
export interface QueryLogsClient {
  /** Run a metric LogQL query at one point in time. A log query is refused with `BadRequest`. */
  query: (
    request: loki.QueryRequest,
  ) => Effect.Effect<loki.QueryResponse, loki.QueryError, RuntimeContext>;
  /** Run a LogQL query over a range of time: log lines for a log query, a matrix for a metric query. */
  queryRange: (
    request: loki.QueryRangeRequest,
  ) => Effect.Effect<loki.QueryRangeResponse, loki.QueryRangeError, RuntimeContext>;
}

/**
 * Bind an {@link Instance} and a {@link Credential} to the instance's Loki query API, on its
 * `logsUrl`. Provide {@link QueryLogsHttp}. Needs a plan with logs, such as
 * `Observability-Starter-EU01`.
 *
 * Calls authenticate with the credential's HTTP Basic, so this grants no STACKIT role
 * and creates no service account: the credential's username and `Redacted` password
 * and the instance's URL travel through the host's environment. STACKIT has no
 * narrower credential, so it can do everything the API allows on the instance: the
 * limit here is the client's surface, not a permission. When the instance has an
 * `acl`, the host's egress address has to be in it.
 *
 * ### Querying Logs
 * **Example:** Read recent lines from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {
 *   plan: "Observability-Starter-EU01",
 * });
 * export const Reader = Metrics.pipe(
 *   Effect.flatMap((metrics) =>
 *     Stackit.Observability.Credential("Reader", { instanceId: metrics.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const reader = yield* Reader;
 *     const queryLogs = yield* Stackit.Observability.QueryLogs(metrics, reader);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* queryLogs.queryRange({ query: '{app="api"}', limit: 10 });
 *         return yield* HttpServerResponse.json({ streams: data.result.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.QueryLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface QueryLogs extends Binding.Service<
  QueryLogs,
  "Stackit.Observability.QueryLogs",
  (instance: Instance, credential: Credential) => Effect.Effect<QueryLogsClient>
> {}

export const QueryLogs = Binding.Service<QueryLogs>("Stackit.Observability.QueryLogs");
