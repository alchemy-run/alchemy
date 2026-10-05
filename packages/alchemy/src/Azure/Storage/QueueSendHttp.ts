import * as Layer from "effect/Layer";
import { AzureDataRole } from "../Binding.ts";
import {
  makeSendStorageQueueClient,
  makeStorageQueueHttpBinding,
} from "./StorageQueueHttp.ts";
import { QueueSend } from "./QueueSend.ts";

/**
 * HTTP implementation of {@link QueueSend}: Queue service REST calls
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.Storage.QueueSend
 */
export const QueueSendHttp = Layer.effect(
  QueueSend,
  makeStorageQueueHttpBinding({
    tag: "Azure.Storage.QueueSend",
    role: AzureDataRole.StorageQueueDataMessageSender,
    makeClient: makeSendStorageQueueClient,
  }),
);
