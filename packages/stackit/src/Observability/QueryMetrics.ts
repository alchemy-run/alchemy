import type * as prometheus from "@distilled.cloud/stackit/observability_prometheus";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";
import type { Instance } from "./Instance.ts";

export interface QueryMetricsLabelsRequest extends Omit<prometheus.LabelsRequest, "match__"> {
  /** Series selectors; only labels of matching series are returned. */
  match?: string[];
}

export interface QueryMetricsLabelValuesRequest extends Omit<
  prometheus.LabelValuesRequest,
  "match__"
> {
  /** Series selectors; only values of matching series are returned. */
  match?: string[];
}

export interface QueryMetricsSeriesRequest extends Omit<prometheus.SeriesRequest, "match__"> {
  /** Series selectors. A series matching any of them is returned. */
  match: string[];
}

/** The Prometheus query API of a bound instance. */
export interface QueryMetricsClient {
  /** Evaluate a PromQL query at one point in time. */
  query: (
    request: prometheus.QueryRequest,
  ) => Effect.Effect<prometheus.QueryOutputBody, prometheus.QueryError, RuntimeContext>;
  /** Evaluate a PromQL query over a range of time. */
  queryRange: (
    request: prometheus.QueryRangeRequest,
  ) => Effect.Effect<prometheus.QueryRangeOutputBody, prometheus.QueryRangeError, RuntimeContext>;
  /** List label names. */
  labels: (
    request?: QueryMetricsLabelsRequest,
  ) => Effect.Effect<prometheus.StringsOutputBody, prometheus.LabelsError, RuntimeContext>;
  /** List the values of one label. */
  labelValues: (
    request: QueryMetricsLabelValuesRequest,
  ) => Effect.Effect<prometheus.StringsOutputBody, prometheus.LabelValuesError, RuntimeContext>;
  /** Find series by selector. */
  series: (
    request: QueryMetricsSeriesRequest,
  ) => Effect.Effect<prometheus.SeriesOutputBody, prometheus.SeriesError, RuntimeContext>;
}

/**
 * Bind an {@link Instance} and a {@link Credential} to the instance's Prometheus query API,
 * on its `metricsUrl`. Provide {@link QueryMetricsHttp}.
 *
 * Calls authenticate with the credential's HTTP Basic, so this grants no STACKIT role
 * and creates no service account: the credential's username and `Redacted` password
 * and the instance's URL travel through the host's environment. STACKIT has no
 * narrower credential, so it can do everything the API allows on the instance: the
 * limit here is the client's surface, not a permission. When the instance has an
 * `acl`, the host's egress address has to be in it.
 *
 * ### Querying Metrics
 * **Example:** Run an instant query from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
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
 *     const queryMetrics = yield* Stackit.Observability.QueryMetrics(metrics, reader);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* queryMetrics.query({ query: "up" });
 *         return yield* HttpServerResponse.json({ series: data.result.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.QueryMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface QueryMetrics extends Binding.Service<
  QueryMetrics,
  "Stackit.Observability.QueryMetrics",
  (instance: Instance, credential: Credential) => Effect.Effect<QueryMetricsClient>
> {}

export const QueryMetrics = Binding.Service<QueryMetrics>("Stackit.Observability.QueryMetrics");
