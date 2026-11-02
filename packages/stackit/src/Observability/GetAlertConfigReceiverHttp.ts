import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAlertConfigReceiver } from "./GetAlertConfigReceiver.ts";

/**
 * HTTP implementation of {@link GetAlertConfigReceiver}.
 *
 * @layer
 * @provides Stackit.Observability.GetAlertConfigReceiver
 */
export const GetAlertConfigReceiverHttp = Layer.effect(
  GetAlertConfigReceiver,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetAlertConfigReceiver",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getAlertConfigReceiver,
  }),
);
