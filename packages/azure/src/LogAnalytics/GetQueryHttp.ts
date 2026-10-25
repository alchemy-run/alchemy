import * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Layer from "effect/Layer";
import { makeWorkspaceQueryBinding } from "./BindingHttp.ts";
import { GetQuery } from "./GetQuery.ts";

/**
 * Implementation of {@link GetQuery} over the distilled
 * `monitor-operational-insights` data plane. Assigns **Log Analytics Data Reader** on the workspace.
 *
 * @layer
 * @provides Azure.LogAnalytics.GetQuery
 */
export const GetQueryHttp = Layer.effect(
  GetQuery,
  makeWorkspaceQueryBinding({ tag: "Azure.LogAnalytics.GetQuery", operation: query.GetQuery }),
);
