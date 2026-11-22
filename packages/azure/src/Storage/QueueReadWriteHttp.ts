import * as Layer from "effect/Layer";
import { QueueReadWrite } from "./QueueReadWrite.ts";
import {
  makeReadWriteStorageQueueClient,
  makeStorageQueueBinding,
  QueueGrants,
} from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link QueueReadWrite} over the distilled
 * `storage-queue` data plane. Assigns a custom role with exactly the permissions its methods need on the queue.
 *
 * @layer
 * @provides Azure.Storage.QueueReadWrite
 */
export const QueueReadWriteHttp = Layer.effect(
  QueueReadWrite,
  makeStorageQueueBinding({
    tag: "Azure.Storage.QueueReadWrite",
    grant: QueueGrants.readWrite,
    makeClient: makeReadWriteStorageQueueClient,
  }),
);
