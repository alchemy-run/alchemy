import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InsightsOptions, InsightsTokenMissing } from "./InsightsBinding.ts";

/**
 * Evaluates a PromQL expression over a time range, one sample per `step`. Pass a personal access token with the `insights:read` scope; it
 * reaches the host as a secret.
 *
 * **Example:** QueryMetricsRange from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const token = yield* Config.Redacted("INSIGHTS_TOKEN");
 *     const query = yield* DigitalOcean.Insights.QueryMetricsRange({ token });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const now = Math.floor(Date.now() / 1000);
 *         const result = yield* query({
 *           region: "nyc3",
 *           query: "up",
 *           start: String(now - 3600),
 *           end: String(now),
 *           step: "60s",
 *         });
 *         return yield* HttpServerResponse.json(result);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Insights.QueryMetricsRangeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Insights
 */
export interface QueryMetricsRange extends Binding.Service<
  QueryMetricsRange,
  "DigitalOcean.Insights.QueryMetricsRange",
  (
    options: InsightsOptions,
  ) => Effect.Effect<
    (
      request: DO.GetInsightPromQueryRangeRequest,
    ) => Effect.Effect<
      DO.PromQueryRangeResponse,
      DO.GetInsightPromQueryRangeError | InsightsTokenMissing,
      RuntimeContext
    >
  >
> {}

export const QueryMetricsRange = Binding.Service<QueryMetricsRange>(
  "DigitalOcean.Insights.QueryMetricsRange",
);
