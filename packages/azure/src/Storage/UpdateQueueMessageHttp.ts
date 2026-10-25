import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";
import { UpdateQueueMessage } from "./UpdateQueueMessage.ts";

/**
 * Implementation of {@link UpdateQueueMessage} over the distilled `storage-queue`
 * `UpdateMessageId` operation. Assigns a custom role with only `messages/write` (Storage Queue Data Contributor also grants queue writes and deletes)
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.UpdateQueueMessage
 */
export const UpdateQueueMessageHttp = Layer.effect(
  UpdateQueueMessage,
  makeQueueOperationBinding({
    tag: "Azure.Storage.UpdateQueueMessage",
    operation: queues.UpdateMessageId,
    grant: QueueGrants.update,
  }),
);
