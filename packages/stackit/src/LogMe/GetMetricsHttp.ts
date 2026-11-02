import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetMetrics } from "./GetMetrics.ts";

/**
 * HTTP implementation of {@link GetMetrics}.
 *
 * @layer
 * @provides Stackit.LogMe.GetMetrics
 */
export const GetMetricsHttp = Layer.effect(
  GetMetrics,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.GetMetrics",
    permission: "logme.proxy.read",
    operation: logme.getMetrics,
  }),
);
