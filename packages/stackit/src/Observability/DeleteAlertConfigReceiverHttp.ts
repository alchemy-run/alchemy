import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertConfigReceiver } from "./DeleteAlertConfigReceiver.ts";

/**
 * HTTP implementation of {@link DeleteAlertConfigReceiver}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertConfigReceiver
 */
export const DeleteAlertConfigReceiverHttp = Layer.effect(
  DeleteAlertConfigReceiver,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertConfigReceiver",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertConfigReceiver,
  }),
);
