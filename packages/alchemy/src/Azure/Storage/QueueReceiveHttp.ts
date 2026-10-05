import * as Layer from "effect/Layer";
import { AzureDataRole } from "../Binding.ts";
import {
  makeReceiveStorageQueueClient,
  makeStorageQueueHttpBinding,
} from "./StorageQueueHttp.ts";
import { QueueReceive } from "./QueueReceive.ts";

/**
 * HTTP implementation of {@link QueueReceive}: Queue service REST calls
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.Storage.QueueReceive
 */
export const QueueReceiveHttp = Layer.effect(
  QueueReceive,
  makeStorageQueueHttpBinding({
    tag: "Azure.Storage.QueueReceive",
    role: AzureDataRole.StorageQueueDataMessageProcessor,
    makeClient: makeReceiveStorageQueueClient,
  }),
);
