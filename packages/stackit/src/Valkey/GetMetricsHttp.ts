import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetMetrics } from "./GetMetrics.ts";

/**
 * HTTP implementation of {@link GetMetrics}.
 *
 * @layer
 * @provides Stackit.Valkey.GetMetrics
 */
export const GetMetricsHttp = Layer.effect(
  GetMetrics,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.GetMetrics",
    permission: "key-value-store.proxy.read",
    operation: valkey.getMetrics,
  }),
);
