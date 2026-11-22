import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { GetQueueServiceStatistics } from "./GetQueueServiceStatistics.ts";
import { makeQueueServiceOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link GetQueueServiceStatistics} over the distilled `storage-queue`
 * `GetServiceStatistics` operation. Assigns a custom role with only the `queueServices/read` action
 * on the storage account.
 *
 * @layer
 * @provides Azure.Storage.GetQueueServiceStatistics
 */
export const GetQueueServiceStatisticsHttp = Layer.effect(
  GetQueueServiceStatistics,
  makeQueueServiceOperationBinding({
    tag: "Azure.Storage.GetQueueServiceStatistics",
    operation: queues.GetServiceStatistics,
    grant: QueueGrants.readService,
    secondary: true,
  }),
);
