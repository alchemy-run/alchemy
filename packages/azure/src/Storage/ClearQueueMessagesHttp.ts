import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { ClearQueueMessages } from "./ClearQueueMessages.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link ClearQueueMessages} over the distilled `storage-queue`
 * `ClearMessage` operation. Assigns a custom role with only `messages/delete`
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.ClearQueueMessages
 */
export const ClearQueueMessagesHttp = Layer.effect(
  ClearQueueMessages,
  makeQueueOperationBinding({
    tag: "Azure.Storage.ClearQueueMessages",
    operation: queues.ClearMessage,
    grant: QueueGrants.clear,
  }),
);
