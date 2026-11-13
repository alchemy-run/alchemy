import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { makeInsightsBinding } from "./InsightsBinding.ts";
import { SearchTraces } from "./SearchTraces.ts";

/**
 * `SearchTraces` over the Insights API.
 *
 * @layer
 * @product Insights
 * @provides DigitalOcean.Insights.SearchTraces
 */
export const SearchTracesHttp = Layer.succeed(
  SearchTraces,
  makeInsightsBinding("DigitalOcean.Insights.SearchTraces", DO.insightsPostTracesSearch),
);
