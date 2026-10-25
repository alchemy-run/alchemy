import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { GetQueueAccessPolicy } from "./GetQueueAccessPolicy.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link GetQueueAccessPolicy} over the distilled `storage-queue`
 * `GetQueueAccessPolicy` operation. Assigns a custom role with only the `queues/getAcl/action` action
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.GetQueueAccessPolicy
 */
export const GetQueueAccessPolicyHttp = Layer.effect(
  GetQueueAccessPolicy,
  makeQueueOperationBinding({
    tag: "Azure.Storage.GetQueueAccessPolicy",
    operation: queues.GetQueueAccessPolicy,
    grant: QueueGrants.getAcl,
  }),
);
