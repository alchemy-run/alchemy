import * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Layer from "effect/Layer";
import { makeWorkspaceQueryBinding } from "./BindingHttp.ts";
import { ExecuteQuery } from "./ExecuteQuery.ts";

/**
 * Implementation of {@link ExecuteQuery} over the distilled
 * `monitor-operational-insights` data plane. Assigns **Log Analytics Data Reader** on the workspace.
 *
 * @layer
 * @provides Azure.LogAnalytics.ExecuteQuery
 */
export const ExecuteQueryHttp = Layer.effect(
  ExecuteQuery,
  makeWorkspaceQueryBinding({
    tag: "Azure.LogAnalytics.ExecuteQuery",
    operation: query.ExecuteQuery,
  }),
);
