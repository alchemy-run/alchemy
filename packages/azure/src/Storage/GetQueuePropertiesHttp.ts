import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { GetQueueProperties } from "./GetQueueProperties.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link GetQueueProperties} over the distilled `storage-queue`
 * `GetQueueProperties` operation. Assigns a custom role with only the `queues/read` action (Storage Queue Data Reader also grants `messages/read`)
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.GetQueueProperties
 */
export const GetQueuePropertiesHttp = Layer.effect(
  GetQueueProperties,
  makeQueueOperationBinding({
    tag: "Azure.Storage.GetQueueProperties",
    operation: queues.GetQueueProperties,
    grant: QueueGrants.readQueue,
  }),
);
