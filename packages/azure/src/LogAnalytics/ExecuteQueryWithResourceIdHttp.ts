import * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Layer from "effect/Layer";
import { makeResourceQueryBinding } from "./BindingHttp.ts";
import { ExecuteQueryWithResourceId } from "./ExecuteQueryWithResourceId.ts";

/**
 * Implementation of {@link ExecuteQueryWithResourceId} over the distilled
 * `monitor-operational-insights` data plane. Assigns the custom `AzureMonitorQueryResourceLogsRole` on the bound resource.
 *
 * @layer
 * @provides Azure.LogAnalytics.ExecuteQueryWithResourceId
 */
export const ExecuteQueryWithResourceIdHttp = Layer.effect(
  ExecuteQueryWithResourceId,
  makeResourceQueryBinding({
    tag: "Azure.LogAnalytics.ExecuteQueryWithResourceId",
    operation: query.ExecuteQueryWithResourceId,
  }),
);
