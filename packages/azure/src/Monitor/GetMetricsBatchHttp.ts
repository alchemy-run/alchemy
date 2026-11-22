import * as Layer from "effect/Layer";
import { makeMetricsBatchBinding } from "./BindingHttp.ts";
import { GetMetricsBatch } from "./GetMetricsBatch.ts";

/**
 * Implementation of {@link GetMetricsBatch} over the distilled
 * `monitor-insights` data plane. Assigns **Monitoring Reader** on the
 * resources' subscription.
 *
 * @layer
 * @provides Azure.Monitor.GetMetricsBatch
 */
export const GetMetricsBatchHttp = Layer.effect(
  GetMetricsBatch,
  makeMetricsBatchBinding("Azure.Monitor.GetMetricsBatch"),
);
