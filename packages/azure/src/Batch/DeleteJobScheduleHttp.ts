import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { DeleteJobSchedule } from "./DeleteJobSchedule.ts";

/**
 * Implementation of {@link DeleteJobSchedule} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchDeleteJobSchedulesRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.DeleteJobSchedule
 */
export const DeleteJobScheduleHttp = Layer.effect(
  DeleteJobSchedule,
  makeBatchAccountBinding({
    tag: "Azure.Batch.DeleteJobSchedule",
    operation: batch.DeleteJobScheduleJobSchedule,
    grants: [BatchRole.DeleteJobSchedules],
  }),
);
