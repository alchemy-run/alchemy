import type { NativeQueue } from "./QueueTypes.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkerEnvironment } from "../../Workers/Worker.ts";
import { Worker } from "../Worker.ts";
import { storageBinding } from "../KV/StorageBinding.ts";
import { QueueConfigurationError, type Queue } from "./Queue.ts";
import {
  SendError,
  WriteQueue,
  type WriteQueueClient,
  type WriteQueueOptions,
} from "./WriteQueue.ts";

/** Build a client without acquiring request-owned objects during initialization. */
export const makeWriteQueueClient = (
  get: () => NativeQueue,
): WriteQueueClient => {
  const failure = (cause: unknown) =>
    new SendError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  const raw = Effect.try({ try: get, catch: failure });
  const use = <A>(f: (queue: NativeQueue) => Promise<A>) =>
    raw.pipe(
      Effect.flatMap((queue) =>
        Effect.tryPromise({
          try: () => f(queue),
          catch: failure,
        }),
      ),
    );
  return {
    raw,
    send: (body, options) => use((queue) => queue.send(body, options)),
    sendBatch: (messages, options) =>
      use((queue) => queue.sendBatch([...messages], options)),
  };
};

/**
 * Native Celld producer implementation. Registers deployment metadata and lazily
 * resolves the producer from the Worker's environment on each call.
 *
 * ### Enable queue producers
 * **Example:** Provide the native producer layer
 * ```typescript
 * implementation.pipe(Effect.provide(Celld.Queues.WriteQueueBinding));
 * ```
 *
 * @layer
 * @provides Celld.Queues.WriteQueue
 * @product Celld
 */
export const WriteQueueBinding = Layer.effect(
  WriteQueue,
  Effect.gen(function* () {
    const host = yield* Worker;
    const env = yield* WorkerEnvironment;
    return Effect.fn(function* (queue: Queue, options: WriteQueueOptions = {}) {
      const delay = options.deliveryDelay;
      if (
        delay !== undefined &&
        (!Number.isInteger(delay) || delay < 0 || delay > 86400)
      ) {
        return yield* Effect.fail(
          new QueueConfigurationError({
            message:
              "Celld producer deliveryDelay must be an integer between 0 and 86400",
          }),
        );
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${queue}`({
          storageBindings: [storageBinding(queue)],
          bindings: [
            {
              type: "queue",
              name: queue.LogicalId,
              queueName: queue.queueName,
              deliveryDelay: delay,
            },
          ],
        });
      }
      return makeWriteQueueClient(() => {
        const binding = env[queue.LogicalId];
        if (!binding)
          throw new Error(
            `Celld queue binding '${queue.LogicalId}' is unavailable`,
          );
        return binding;
      });
    });
  }),
);
