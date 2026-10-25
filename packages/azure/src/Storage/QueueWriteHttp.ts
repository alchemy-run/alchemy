import * as Layer from "effect/Layer";
import { QueueWrite } from "./QueueWrite.ts";
import {
  makeWriteStorageQueueClient,
  makeStorageQueueBinding,
  QueueGrants,
} from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link QueueWrite} over the distilled
 * `storage-queue` data plane. Assigns a custom role with only `messages/write`, `messages/delete`, and
 * `messages/process/action` on the queue.
 *
 * @layer
 * @provides Azure.Storage.QueueWrite
 */
export const QueueWriteHttp = Layer.effect(
  QueueWrite,
  makeStorageQueueBinding({
    tag: "Azure.Storage.QueueWrite",
    grant: QueueGrants.write,
    makeClient: makeWriteStorageQueueClient,
  }),
);
