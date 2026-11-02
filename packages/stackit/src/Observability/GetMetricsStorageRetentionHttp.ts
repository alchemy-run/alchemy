import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetMetricsStorageRetention } from "./GetMetricsStorageRetention.ts";

/**
 * HTTP implementation of {@link GetMetricsStorageRetention}.
 *
 * @layer
 * @provides Stackit.Observability.GetMetricsStorageRetention
 */
export const GetMetricsStorageRetentionHttp = Layer.effect(
  GetMetricsStorageRetention,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetMetricsStorageRetention",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getMetricsStorageRetention,
  }),
);
