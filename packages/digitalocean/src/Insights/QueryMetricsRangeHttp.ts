import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { makeInsightsBinding } from "./InsightsBinding.ts";
import { QueryMetricsRange } from "./QueryMetricsRange.ts";

/**
 * `QueryMetricsRange` over the Insights API.
 *
 * @layer
 * @product Insights
 * @provides DigitalOcean.Insights.QueryMetricsRange
 */
export const QueryMetricsRangeHttp = Layer.succeed(
  QueryMetricsRange,
  makeInsightsBinding("DigitalOcean.Insights.QueryMetricsRange", DO.getInsightPromQueryRange),
);
