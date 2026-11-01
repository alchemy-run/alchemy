import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateAlertConfigReceiver } from "./UpdateAlertConfigReceiver.ts";

/**
 * HTTP implementation of {@link UpdateAlertConfigReceiver}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateAlertConfigReceiver
 */
export const UpdateAlertConfigReceiverHttp = Layer.effect(
  UpdateAlertConfigReceiver,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpdateAlertConfigReceiver",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateAlertConfigReceiver,
  }),
);
