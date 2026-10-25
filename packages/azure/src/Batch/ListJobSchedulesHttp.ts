import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { ListJobSchedules } from "./ListJobSchedules.ts";

/**
 * Implementation of {@link ListJobSchedules} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadJobSchedulesRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.ListJobSchedules
 */
export const ListJobSchedulesHttp = Layer.effect(
  ListJobSchedules,
  makeBatchAccountBinding({
    tag: "Azure.Batch.ListJobSchedules",
    operation: batch.ListJobScheduleJobSchedules,
    grants: [BatchRole.ReadJobSchedules],
  }),
);
