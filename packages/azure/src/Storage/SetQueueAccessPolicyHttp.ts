import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { SetQueueAccessPolicy } from "./SetQueueAccessPolicy.ts";
import { makeQueueOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link SetQueueAccessPolicy} over the distilled `storage-queue`
 * `SetQueueAccessPolicy` operation. Assigns a custom role with only the `queues/setAcl/action` action
 * on the queue only.
 *
 * @layer
 * @provides Azure.Storage.SetQueueAccessPolicy
 */
export const SetQueueAccessPolicyHttp = Layer.effect(
  SetQueueAccessPolicy,
  makeQueueOperationBinding({
    tag: "Azure.Storage.SetQueueAccessPolicy",
    operation: queues.SetQueueAccessPolicy,
    grant: QueueGrants.setAcl,
  }),
);
