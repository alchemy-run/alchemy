import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { GetJobSchedule } from "./GetJobSchedule.ts";

/**
 * Implementation of {@link GetJobSchedule} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadJobSchedulesRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.GetJobSchedule
 */
export const GetJobScheduleHttp = Layer.effect(
  GetJobSchedule,
  makeBatchAccountBinding({
    tag: "Azure.Batch.GetJobSchedule",
    operation: batch.GetJobScheduleJobSchedule,
    grants: [BatchRole.ReadJobSchedules],
  }),
);
