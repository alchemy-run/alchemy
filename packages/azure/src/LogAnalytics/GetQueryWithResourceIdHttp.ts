import * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Layer from "effect/Layer";
import { makeResourceQueryBinding } from "./BindingHttp.ts";
import { GetQueryWithResourceId } from "./GetQueryWithResourceId.ts";

/**
 * Implementation of {@link GetQueryWithResourceId} over the distilled
 * `monitor-operational-insights` data plane. Assigns the custom `AzureMonitorQueryResourceLogsRole` on the bound resource.
 *
 * @layer
 * @provides Azure.LogAnalytics.GetQueryWithResourceId
 */
export const GetQueryWithResourceIdHttp = Layer.effect(
  GetQueryWithResourceId,
  makeResourceQueryBinding({
    tag: "Azure.LogAnalytics.GetQueryWithResourceId",
    operation: query.GetQueryWithResourceId,
  }),
);
