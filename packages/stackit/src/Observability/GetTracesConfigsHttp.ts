import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetTracesConfigs } from "./GetTracesConfigs.ts";

/**
 * HTTP implementation of {@link GetTracesConfigs}.
 *
 * @layer
 * @provides Stackit.Observability.GetTracesConfigs
 */
export const GetTracesConfigsHttp = Layer.effect(
  GetTracesConfigs,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetTracesConfigs",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getTracesConfigs,
  }),
);
