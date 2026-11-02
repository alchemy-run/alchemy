import * as Layer from "effect/Layer";
import { makeMetricsBinding, makeQueryMetricsClient } from "./BindingHttp.ts";
import { QueryMetrics } from "./QueryMetrics.ts";

/**
 * HTTP implementation of {@link QueryMetrics}, on the instance's Prometheus API.
 *
 * @layer
 * @provides Stackit.Observability.QueryMetrics
 */
export const QueryMetricsHttp = Layer.succeed(
  QueryMetrics,
  makeMetricsBinding(makeQueryMetricsClient),
);
