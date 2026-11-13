import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InsightsOptions, InsightsTokenMissing } from "./InsightsBinding.ts";

/**
 * Evaluates a PromQL expression at one instant over a region's metrics. Pass a personal access token with the `insights:read` scope; it
 * reaches the host as a secret.
 *
 * **Example:** QueryMetrics from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const token = yield* Config.Redacted("INSIGHTS_TOKEN");
 *     const query = yield* DigitalOcean.Insights.QueryMetrics({ token });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* query({ region: "nyc3", query: "up" });
 *         return yield* HttpServerResponse.json(result);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Insights.QueryMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Insights
 */
export interface QueryMetrics extends Binding.Service<
  QueryMetrics,
  "DigitalOcean.Insights.QueryMetrics",
  (
    options: InsightsOptions,
  ) => Effect.Effect<
    (
      request: DO.GetInsightPromQueryRequest,
    ) => Effect.Effect<
      DO.PromQueryResponse,
      DO.GetInsightPromQueryError | InsightsTokenMissing,
      RuntimeContext
    >
  >
> {}

export const QueryMetrics = Binding.Service<QueryMetrics>("DigitalOcean.Insights.QueryMetrics");
