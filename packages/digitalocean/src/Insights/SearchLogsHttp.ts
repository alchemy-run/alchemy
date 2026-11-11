import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { makeInsightsBinding } from "./InsightsBinding.ts";
import { SearchLogs } from "./SearchLogs.ts";

/**
 * `SearchLogs` over the Insights API.
 *
 * @layer
 * @product Insights
 * @provides DigitalOcean.Insights.SearchLogs
 */
export const SearchLogsHttp = Layer.succeed(
  SearchLogs,
  makeInsightsBinding("DigitalOcean.Insights.SearchLogs", DO.insightsPostLogsSearch),
);
