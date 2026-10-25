import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { QueueSend } from "./QueueSend.ts";
import { makeSendStorageQueueClient, makeStorageQueueBinding } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link QueueSend} over the distilled `storage-queue`
 * data plane. Assigns **Storage Queue Data Message Sender** on the queue.
 *
 * @layer
 * @provides Azure.Storage.QueueSend
 */
export const QueueSendHttp = Layer.effect(
  QueueSend,
  makeStorageQueueBinding({
    tag: "Azure.Storage.QueueSend",
    role: BuiltInRole.StorageQueueDataMessageSender,
    makeClient: makeSendStorageQueueClient,
  }),
);
