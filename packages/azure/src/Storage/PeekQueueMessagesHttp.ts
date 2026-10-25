import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { PeekQueueMessages } from "./PeekQueueMessages.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link PeekQueueMessages} over the distilled `storage-queue`
 * `MessagesPeek` operation. Assigns **Storage Queue Data Reader** (`messages/read` data action, plus the `queues/read` action)
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.PeekQueueMessages
 */
export const PeekQueueMessagesHttp = Layer.effect(
  PeekQueueMessages,
  makeQueueOperationBinding({
    tag: "Azure.Storage.PeekQueueMessages",
    operation: queues.MessagesPeek,
    grant: QueueGrants.peek,
  }),
);
