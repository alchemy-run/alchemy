import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetMetrics } from "./GetMetrics.ts";

/**
 * HTTP implementation of {@link GetMetrics}.
 *
 * @layer
 * @provides Stackit.OpenSearch.GetMetrics
 */
export const GetMetricsHttp = Layer.effect(
  GetMetrics,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.GetMetrics",
    permission: "opensearch.proxy.read",
    operation: opensearch.getMetrics,
  }),
);
