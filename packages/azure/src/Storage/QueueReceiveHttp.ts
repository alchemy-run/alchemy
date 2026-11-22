import * as Layer from "effect/Layer";
import { QueueReceive } from "./QueueReceive.ts";
import {
  makeReceiveStorageQueueClient,
  makeStorageQueueBinding,
  QueueGrants,
} from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link QueueReceive} over the distilled
 * `storage-queue` data plane. Assigns **Storage Queue Data Message
 * Processor** on the queue.
 *
 * @layer
 * @provides Azure.Storage.QueueReceive
 */
export const QueueReceiveHttp = Layer.effect(
  QueueReceive,
  makeStorageQueueBinding({
    tag: "Azure.Storage.QueueReceive",
    grant: QueueGrants.receive,
    makeClient: makeReceiveStorageQueueClient,
  }),
);
