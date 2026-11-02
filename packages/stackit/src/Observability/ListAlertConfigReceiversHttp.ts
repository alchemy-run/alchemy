import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAlertConfigReceivers } from "./ListAlertConfigReceivers.ts";

/**
 * HTTP implementation of {@link ListAlertConfigReceivers}.
 *
 * @layer
 * @provides Stackit.Observability.ListAlertConfigReceivers
 */
export const ListAlertConfigReceiversHttp = Layer.effect(
  ListAlertConfigReceivers,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListAlertConfigReceivers",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listAlertConfigReceivers,
  }),
);
