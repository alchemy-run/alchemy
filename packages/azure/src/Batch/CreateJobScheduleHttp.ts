import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { CreateJobSchedule } from "./CreateJobSchedule.ts";

/**
 * Implementation of {@link CreateJobSchedule} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchWriteJobSchedulesRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.CreateJobSchedule
 */
export const CreateJobScheduleHttp = Layer.effect(
  CreateJobSchedule,
  makeBatchAccountBinding({
    tag: "Azure.Batch.CreateJobSchedule",
    operation: batch.CreateJobScheduleJobSchedule,
    grants: [BatchRole.WriteJobSchedules],
  }),
);
