import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAlertRecord } from "./GetAlertRecord.ts";

/**
 * HTTP implementation of {@link GetAlertRecord}.
 *
 * @layer
 * @provides Stackit.Observability.GetAlertRecord
 */
export const GetAlertRecordHttp = Layer.effect(
  GetAlertRecord,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetAlertRecord",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getAlertRecord,
  }),
);
