import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Queue } from "./Queue.ts";
import { QueueOps, makeReadWriteQueueClient } from "./QueueClient.ts";
import { ReadWriteQueue } from "./ReadWriteQueue.ts";

/**
 * {@link ReadWriteQueue} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the queue's environment.
 *
 * @layer
 * @product Queue
 * @provides Modal.ReadWriteQueue
 */
export const ReadWriteQueueHttp = Layer.effect(
  ReadWriteQueue,
  makeModalBinding({
    tag: "Modal.ReadWriteQueue",
    operations: QueueOps,
    role: "contributor",
    make: Effect.fn(function* (queue: Queue, ops) {
      const queueId = yield* queue.queueId;
      return makeReadWriteQueueClient(queueId, ops);
    }),
  }),
);
