import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateAlertConfigReceiver } from "./CreateAlertConfigReceiver.ts";

/**
 * HTTP implementation of {@link CreateAlertConfigReceiver}.
 *
 * @layer
 * @provides Stackit.Observability.CreateAlertConfigReceiver
 */
export const CreateAlertConfigReceiverHttp = Layer.effect(
  CreateAlertConfigReceiver,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateAlertConfigReceiver",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createAlertConfigReceiver,
  }),
);
