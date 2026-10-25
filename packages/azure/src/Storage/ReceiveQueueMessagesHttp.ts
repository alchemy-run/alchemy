import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { ReceiveQueueMessages } from "./ReceiveQueueMessages.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link ReceiveQueueMessages} over the distilled `storage-queue`
 * `MessagesDequeue` operation. Assigns a custom role with only `messages/process/action` (every built-in queue role also grants `messages/read`)
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.ReceiveQueueMessages
 */
export const ReceiveQueueMessagesHttp = Layer.effect(
  ReceiveQueueMessages,
  makeQueueOperationBinding({
    tag: "Azure.Storage.ReceiveQueueMessages",
    operation: queues.MessagesDequeue,
    grant: QueueGrants.process,
  }),
);
