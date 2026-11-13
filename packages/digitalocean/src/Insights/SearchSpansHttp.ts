import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { makeInsightsBinding } from "./InsightsBinding.ts";
import { SearchSpans } from "./SearchSpans.ts";

/**
 * `SearchSpans` over the Insights API.
 *
 * @layer
 * @product Insights
 * @provides DigitalOcean.Insights.SearchSpans
 */
export const SearchSpansHttp = Layer.succeed(
  SearchSpans,
  makeInsightsBinding("DigitalOcean.Insights.SearchSpans", DO.insightsPostSpansSearch),
);
