import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpsertAlertRecords } from "./UpsertAlertRecords.ts";

/**
 * HTTP implementation of {@link UpsertAlertRecords}.
 *
 * @layer
 * @provides Stackit.Observability.UpsertAlertRecords
 */
export const UpsertAlertRecordsHttp = Layer.effect(
  UpsertAlertRecords,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpsertAlertRecords",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.partialUpdateAlertRecords,
  }),
);
