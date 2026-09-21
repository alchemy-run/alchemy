import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { isWorkerEvent } from "../../Cloudflare/Workers/WorkerRuntime.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import * as DurationUtil from "../../Util/Duration.ts";
import { Worker } from "../Worker.ts";
import { Consumer, claimConsumer } from "./Consumer.ts";
import type { Queue, QueueConfigurationError } from "./Queue.ts";
import type { Message, MessageBatch } from "./QueueTypes.ts";

/** Native push delivery settings for a stream listener. */
export interface MessagesProps {
  /** Maximum messages per batch, 1–100. */
  batchSize?: number;
  /** Maximum concurrent deliveries, 1–250. */
  maxConcurrency?: number;
  /** Retry limit, 0–100. */
  maxRetries?: number;
  /** Partial-batch timeout, rounded up to seconds. */
  maxWaitTime?: Duration.Input;
  /** Delay before retry, rounded up to seconds. */
  retryDelay?: Duration.Input;
  /** Dead-letter queue in the same fleet. */
  deadLetterQueue?: Queue;
}

/** Convert durations to the low-level consumer settings. @internal */
export const toConsumerSettings = (props: MessagesProps) => ({
  batchSize: props.batchSize,
  maxConcurrency: props.maxConcurrency,
  maxRetries: props.maxRetries,
  maxWaitTimeMs: DurationUtil.toMillis(props.maxWaitTime),
  retryDelay: DurationUtil.toSeconds(props.retryDelay),
});

type Process<Body, R> = (
  messages: Stream.Stream<Message<Body>>,
) => Effect.Effect<void, unknown, R>;

/**
 * Consume a queue as an Effect stream. Success acknowledges unsettled messages;
 * failure retries unsettled messages without overriding explicit acknowledgements.
 * Delivery is at least once. The listener must complete all settlement before returning.
 *
 * ### Process messages
 * **Example:** Register a consumer and its listener together
 * ```typescript
 * yield* Celld.Queues.consumeQueueMessages(jobs, { deadLetterQueue: failed },
 *   (messages) => Stream.runForEach(messages, (message) => Effect.log(message.body)));
 * ```
 *
 * @binding
 * @product Celld
 */
export function consumeQueueMessages<
  Body = unknown,
  R = RuntimeContext | Scope.Scope,
>(
  queue: Queue,
  process: Process<Body, R>,
): Effect.Effect<
  void,
  QueueConfigurationError,
  EventSource | Exclude<R, RuntimeContext | Scope.Scope>
>;
export function consumeQueueMessages<
  Body = unknown,
  R = RuntimeContext | Scope.Scope,
>(
  queue: Queue,
  props: MessagesProps,
  process: Process<Body, R>,
): Effect.Effect<
  void,
  QueueConfigurationError,
  EventSource | Exclude<R, RuntimeContext | Scope.Scope>
>;
export function consumeQueueMessages<
  Body = unknown,
  R = RuntimeContext | Scope.Scope,
>(
  queue: Queue,
  propsOrProcess: MessagesProps | Process<Body, R>,
  process?: Process<Body, R>,
) {
  return EventSource.use((source) =>
    typeof propsOrProcess === "function"
      ? source(queue, {}, propsOrProcess)
      : source(queue, propsOrProcess, process!),
  );
}

export type EventSourceService = <Body, R>(
  queue: Queue,
  props: MessagesProps,
  process: Process<Body, R>,
) => Effect.Effect<
  void,
  QueueConfigurationError,
  Exclude<R, RuntimeContext | Scope.Scope>
>;

/** Service registering Celld queue stream listeners. */
export class EventSource extends Context.Service<
  EventSource,
  EventSourceService
>()("Celld.Queues.EventSource") {}

/** Process one native batch without erasing explicit per-message settlement. @internal */
export const processQueueBatch = <Body, R>(
  batch: MessageBatch<Body>,
  process: Process<Body, R>,
) =>
  Effect.suspend(() => process(Stream.fromIterable(batch.messages))).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        for (const message of batch.messages) message.ack();
      }),
    ),
    Effect.onError((cause) =>
      Effect.logError("Celld queue handler failed", cause).pipe(
        Effect.andThen(
          Effect.sync(() => {
            for (const message of batch.messages) message.retry();
          }),
        ),
      ),
    ),
    Effect.catchCause(() => Effect.void),
  );

/**
 * Register native queue attachments at deployment and queue listeners at runtime.
 *
 * ### Enable queue consumption
 * **Example:** Provide the event source on a Worker implementation
 * ```typescript
 * implementation.pipe(Effect.provide(Celld.Queues.EventSourceLive));
 * ```
 *
 * @layer
 * @provides Celld.Queues.EventSource
 * @product Celld
 */
export const EventSourceLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return Effect.fn(function* <Body, R>(
      queue: Queue,
      props: MessagesProps,
      process: Process<Body, R>,
    ) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Consumer(`${queue.LogicalId}Consumer`, {
          queue,
          settings: toConsumerSettings(props),
          deadLetterQueue: props.deadLetterQueue,
        });
      } else {
        yield* claimConsumer(host, queue.LogicalId);
      }
      const context = (yield* RuntimeContext) as unknown as FunctionContext;
      const queueName = yield* queue.queueName;
      yield* context.listen<void, R>((event) => {
        if (!isWorkerEvent(event) || event.type !== "queue") return;
        const batch = event.input as MessageBatch<Body>;
        return Effect.gen(function* () {
          if (batch.queue !== (yield* queueName)) return;
          yield* processQueueBatch(batch, process);
        });
      });
    }) as EventSourceService;
  }),
);
