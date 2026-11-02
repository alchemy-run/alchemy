import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateAlertRecord } from "./UpdateAlertRecord.ts";

/**
 * HTTP implementation of {@link UpdateAlertRecord}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateAlertRecord
 */
export const UpdateAlertRecordHttp = Layer.effect(
  UpdateAlertRecord,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpdateAlertRecord",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateAlertRecord,
  }),
);
