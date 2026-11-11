import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Queue } from "./Queue.ts";
import { QueueOps, makeReadQueueClient } from "./QueueClient.ts";
import { ReadQueue } from "./ReadQueue.ts";

/**
 * {@link ReadQueue} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the queue's environment.
 *
 * @layer
 * @product Queue
 * @provides Modal.ReadQueue
 */
export const ReadQueueHttp = Layer.effect(
  ReadQueue,
  makeModalBinding({
    tag: "Modal.ReadQueue",
    operations: QueueOps,
    role: "contributor",
    make: Effect.fn(function* (queue: Queue, ops) {
      const queueId = yield* queue.queueId;
      return makeReadQueueClient(queueId, ops);
    }),
  }),
);
