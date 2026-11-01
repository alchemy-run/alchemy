import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAlertRecords } from "./ListAlertRecords.ts";

/**
 * HTTP implementation of {@link ListAlertRecords}.
 *
 * @layer
 * @provides Stackit.Observability.ListAlertRecords
 */
export const ListAlertRecordsHttp = Layer.effect(
  ListAlertRecords,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListAlertRecords",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listAlertRecords,
  }),
);
