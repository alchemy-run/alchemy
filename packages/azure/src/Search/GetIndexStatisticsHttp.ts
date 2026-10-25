import * as searchData from "@distilled.cloud/azure/search-data";
import * as Layer from "effect/Layer";
import { makeSearchIndexHttpBinding, SearchRole } from "./BindingHttp.ts";
import { GetIndexStatistics } from "./GetIndexStatistics.ts";

/**
 * Implementation of {@link GetIndexStatistics} over the distilled `search-data`
 * data plane. Assigns the custom
 * `AzureSearchIndexStatisticsRole` on the index.
 *
 * @layer
 * @provides Azure.Search.GetIndexStatistics
 */
export const GetIndexStatisticsHttp = Layer.effect(
  GetIndexStatistics,
  makeSearchIndexHttpBinding({
    tag: "Azure.Search.GetIndexStatistics",
    operation: searchData.GetIndexStatistics,
    grants: [SearchRole.ReadIndexStatistics],
  }),
);
