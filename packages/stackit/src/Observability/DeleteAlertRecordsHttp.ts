import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertRecords } from "./DeleteAlertRecords.ts";

/**
 * HTTP implementation of {@link DeleteAlertRecords}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertRecords
 */
export const DeleteAlertRecordsHttp = Layer.effect(
  DeleteAlertRecords,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertRecords",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertRecords,
  }),
);
