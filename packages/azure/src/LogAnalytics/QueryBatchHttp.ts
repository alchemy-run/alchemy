import * as Layer from "effect/Layer";
import { makeQueryBatchBinding } from "./BindingHttp.ts";
import { QueryBatch } from "./QueryBatch.ts";

/**
 * Implementation of {@link QueryBatch} over the distilled
 * `monitor-operational-insights` data plane. Assigns **Log Analytics Data
 * Reader** on the workspace.
 *
 * @layer
 * @provides Azure.LogAnalytics.QueryBatch
 */
export const QueryBatchHttp = Layer.effect(
  QueryBatch,
  makeQueryBatchBinding("Azure.LogAnalytics.QueryBatch"),
);
