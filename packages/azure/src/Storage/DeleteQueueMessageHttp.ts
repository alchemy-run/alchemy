import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { DeleteQueueMessage } from "./DeleteQueueMessage.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link DeleteQueueMessage} over the distilled `storage-queue`
 * `DeleteMessageId` operation. Assigns a custom role with only `messages/process/action`
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.DeleteQueueMessage
 */
export const DeleteQueueMessageHttp = Layer.effect(
  DeleteQueueMessage,
  makeQueueOperationBinding({
    tag: "Azure.Storage.DeleteQueueMessage",
    operation: queues.DeleteMessageId,
    grant: QueueGrants.process,
  }),
);
