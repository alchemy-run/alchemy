import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { makeInsightsBinding } from "./InsightsBinding.ts";
import { QueryMetrics } from "./QueryMetrics.ts";

/**
 * `QueryMetrics` over the Insights API.
 *
 * @layer
 * @product Insights
 * @provides DigitalOcean.Insights.QueryMetrics
 */
export const QueryMetricsHttp = Layer.succeed(
  QueryMetrics,
  makeInsightsBinding("DigitalOcean.Insights.QueryMetrics", DO.getInsightPromQuery),
);
