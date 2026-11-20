import * as sqs from "@distilled.cloud/aws/sqs";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Queue } from "./Queue.ts";

export interface StartMessageMoveTaskRequest extends Omit<
  sqs.StartMessageMoveTaskRequest,
  "SourceArn" | "DestinationArn"
> {}

/**
 * Runtime binding for `sqs:StartMessageMoveTask` (dead-letter queue
 * redrive).
 *
 * Bind this operation to a dead-letter {@link Queue} (the redrive *source*)
 * inside a function runtime to start moving its messages. Redrive requires
 * more than the start permission alone, so the binding grants the host
 * function `sqs:StartMessageMoveTask`, `sqs:ReceiveMessage`,
 * `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on the source queue.
 *
 * Pass a `destination` Queue at bind time to redrive into a specific queue
 * (grants `sqs:SendMessage` + `sqs:GetQueueAttributes` on it and injects its
 * ARN as `DestinationArn`). Without a destination, messages are redriven to
 * their original source queues — which requires `sqs:SendMessage` on those
 * queues, so the binding grants `sqs:SendMessage` on `*` in that mode.
 *
 * Provide the `StartMessageMoveTaskHttp` layer on the Function to implement
 * the binding.
 * ### Dead-Letter Queue Redrive
 * **Example:** Redrive a DLQ into a Specific Queue
 * ```typescript
 * // init (provide SQS.StartMessageMoveTaskHttp on the Function)
 * const startMessageMoveTask = yield* SQS.StartMessageMoveTask(dlq, {
 *   destination: ordersQueue,
 * });
 *
 * // runtime
 * const { TaskHandle } = yield* startMessageMoveTask();
 * ```
 *
 * **Example:** Rate-Limited Redrive
 * ```typescript
 * yield* startMessageMoveTask({ MaxNumberOfMessagesPerSecond: 10 });
 * ```
 *
 * @binding
 */
export interface StartMessageMoveTask extends Binding.Service<
  StartMessageMoveTask,
  "AWS.SQS.StartMessageMoveTask",
  (
    source: Queue,
    options?: {
      /**
       * The queue messages are redriven into. When omitted, messages are
       * moved back to their original source queues (and the binding grants
       * `sqs:SendMessage` on `*`).
       */
      destination?: Queue;
    },
  ) => Effect.Effect<
    (
      request?: StartMessageMoveTaskRequest,
    ) => Effect.Effect<sqs.StartMessageMoveTaskResult, sqs.StartMessageMoveTaskError>
  >
> {}

export const StartMessageMoveTask = Binding.Service<StartMessageMoveTask>(
  "AWS.SQS.StartMessageMoveTask",
);

// Bespoke (not the shared scaffold): redrive spans TWO queues. The source
// (DLQ) needs the start/receive/delete/get-attributes actions, and the
// destination needs send/get-attributes — on `*` when no explicit
// destination is given, because "redrive to original source queues" targets
// queues unknowable at deploy time.
export const StartMessageMoveTaskHttp = Layer.effect(
  StartMessageMoveTask,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startMessageMoveTask = yield* AWSBindings.withCredentials(sqs.startMessageMoveTask);

    return Effect.fn(function* (source: Queue, options?: { destination?: Queue }) {
      const SourceArn = yield* source.queueArn;
      const destination = options?.destination;
      const DestinationArn = destination ? yield* destination.queueArn : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.SQS.StartMessageMoveTask(${source})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "sqs:StartMessageMoveTask",
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
              ],
              Resource: [Output.interpolate`${source.queueArn}`],
            },
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage", "sqs:GetQueueAttributes"],
              Resource: [destination ? Output.interpolate`${destination.queueArn}` : "*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.SQS.StartMessageMoveTask(${source.LogicalId})`)(function* (
        request?: StartMessageMoveTaskRequest,
      ) {
        return yield* startMessageMoveTask({
          ...request,
          SourceArn: yield* SourceArn,
          ...(DestinationArn !== undefined ? { DestinationArn: yield* DestinationArn } : {}),
        });
      });
    });
  }),
);
