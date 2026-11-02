import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateAlertRecord } from "./CreateAlertRecord.ts";

/**
 * HTTP implementation of {@link CreateAlertRecord}.
 *
 * @layer
 * @provides Stackit.Observability.CreateAlertRecord
 */
export const CreateAlertRecordHttp = Layer.effect(
  CreateAlertRecord,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateAlertRecord",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createAlertRecord,
  }),
);
