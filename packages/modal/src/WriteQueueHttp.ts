import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Queue } from "./Queue.ts";
import { QueueOps, makeWriteQueueClient } from "./QueueClient.ts";
import { WriteQueue } from "./WriteQueue.ts";

/**
 * {@link WriteQueue} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the queue's environment.
 *
 * @layer
 * @product Queue
 * @provides Modal.WriteQueue
 */
export const WriteQueueHttp = Layer.effect(
  WriteQueue,
  makeModalBinding({
    tag: "Modal.WriteQueue",
    operations: QueueOps,
    role: "contributor",
    make: Effect.fn(function* (queue: Queue, ops) {
      const queueId = yield* queue.queueId;
      return makeWriteQueueClient(queueId, ops);
    }),
  }),
);
