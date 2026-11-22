import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { SendQueueMessage } from "./SendQueueMessage.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link SendQueueMessage} over the distilled `storage-queue`
 * `MessagesEnqueue` operation. Assigns **Storage Queue Data Message Sender** (`messages/add/action`)
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.SendQueueMessage
 */
export const SendQueueMessageHttp = Layer.effect(
  SendQueueMessage,
  makeQueueOperationBinding({
    tag: "Azure.Storage.SendQueueMessage",
    operation: queues.MessagesEnqueue,
    grant: QueueGrants.send,
  }),
);
