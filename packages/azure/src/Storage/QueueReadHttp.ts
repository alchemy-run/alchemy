import * as Layer from "effect/Layer";
import { QueueRead } from "./QueueRead.ts";
import {
  makeReadStorageQueueClient,
  makeStorageQueueBinding,
  QueueGrants,
} from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link QueueRead} over the distilled
 * `storage-queue` data plane. Assigns **Storage Queue Data Reader** on the queue.
 *
 * @layer
 * @provides Azure.Storage.QueueRead
 */
export const QueueReadHttp = Layer.effect(
  QueueRead,
  makeStorageQueueBinding({
    tag: "Azure.Storage.QueueRead",
    grant: QueueGrants.peek,
    makeClient: makeReadStorageQueueClient,
  }),
);
