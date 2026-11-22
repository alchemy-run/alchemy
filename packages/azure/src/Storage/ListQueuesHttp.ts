import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { ListQueues } from "./ListQueues.ts";
import { makeQueueServiceOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link ListQueues} over the distilled `storage-queue`
 * `ListServiceQueuesSegment` operation. Assigns a custom role with only the `queues/read` action
 * on the storage account.
 *
 * @layer
 * @provides Azure.Storage.ListQueues
 */
export const ListQueuesHttp = Layer.effect(
  ListQueues,
  makeQueueServiceOperationBinding({
    tag: "Azure.Storage.ListQueues",
    operation: queues.ListServiceQueuesSegment,
    grant: QueueGrants.readQueue,
  }),
);
