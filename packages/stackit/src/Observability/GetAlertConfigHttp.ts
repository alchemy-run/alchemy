import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAlertConfig } from "./GetAlertConfig.ts";

/**
 * HTTP implementation of {@link GetAlertConfig}.
 *
 * @layer
 * @provides Stackit.Observability.GetAlertConfig
 */
export const GetAlertConfigHttp = Layer.effect(
  GetAlertConfig,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetAlertConfig",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getAlertConfigs,
  }),
);
