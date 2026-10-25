import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** One Storage queue message delivered to a handler. */
export interface QueueMessage {
  /** Message text, JSON-decoded when it is JSON. */
  body: unknown;
  /** Message ID. */
  id: string | undefined;
  /** How many times the message has been dequeued (1 on first delivery). */
  dequeueCount: number | undefined;
  /** When the message was added to the queue. */
  insertionTime: string | undefined;
  /** All trigger metadata the host passed (`PopReceipt`, `ExpirationTime`, …). */
  metadata: Record<string, unknown>;
}

export interface QueueEventSourceProps {
  /**
   * Name of the trigger function on the host (letters, digits, `_`, `-`).
   * @default `queue-<queue logical ID>`
   */
  functionName?: string;
}

export type QueueEventSourceService = <Req = never>(
  queue: Queue,
  props: QueueEventSourceProps,
  handler: (message: QueueMessage) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source connecting an Azure Storage {@link Queue} to the runtime
 * that hosts it. Consume it with {@link consumeQueueMessages} and provide
 * the host's implementation: `Azure.Functions.StorageQueueEventSource` (a
 * native `queueTrigger` function).
 *
 * The host delivers one message per invocation. A handler that fails
 * (defects) makes the host retry the message; after five dequeues it moves
 * to `<queue>-poison`.
 *
 * ### Consuming a Queue
 * **Example:** Log each message in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
 *       Effect.log(`job ${message.id}: ${JSON.stringify(message.body)}`),
 *     );
 *   }).pipe(Effect.provide(Azure.Functions.StorageQueueEventSource)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueueEventSource extends Binding.Service<
  QueueEventSource,
  "Azure.Storage.QueueEventSource",
  QueueEventSourceService
> {}

export const QueueEventSource = Binding.Service<QueueEventSource>(
  "Azure.Storage.QueueEventSource",
);

/**
 * Run `handler` for every message added to `queue`.
 *
 * @example
 * ```typescript
 * yield* Azure.Storage.consumeQueueMessages(jobs, (message) => Effect.log(message.body));
 * ```
 */
export function consumeQueueMessages<Q extends Queue, Req = never, QueueReq = never>(
  queue: Q | Effect.Effect<Q, never, QueueReq>,
  handler: (message: QueueMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, QueueEventSource | QueueReq>;
export function consumeQueueMessages<Q extends Queue, Req = never, QueueReq = never>(
  queue: Q | Effect.Effect<Q, never, QueueReq>,
  props: QueueEventSourceProps,
  handler: (message: QueueMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, QueueEventSource | QueueReq>;
export function consumeQueueMessages<Q extends Queue, Req = never, QueueReq = never>(
  queue: Q | Effect.Effect<Q, never, QueueReq>,
  propsOrHandler: QueueEventSourceProps | ((message: QueueMessage) => Effect.Effect<void, never, Req>),
  maybeHandler?: (message: QueueMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, QueueEventSource | QueueReq> {
  const [props, handler] =
    typeof propsOrHandler === "function"
      ? [{} as QueueEventSourceProps, propsOrHandler]
      : [propsOrHandler, maybeHandler!];
  const resolved = Effect.isEffect(queue) ? queue : Effect.succeed(queue);
  return resolved.pipe(
    Effect.flatMap((value) => QueueEventSource.use((source) => source(value, props, handler))),
  );
}
