import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertRecord } from "./DeleteAlertRecord.ts";

/**
 * HTTP implementation of {@link DeleteAlertRecord}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertRecord
 */
export const DeleteAlertRecordHttp = Layer.effect(
  DeleteAlertRecord,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertRecord",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertRecord,
  }),
);
