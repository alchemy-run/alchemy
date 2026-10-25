import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** One Service Bus message delivered to a handler. */
export interface ServiceBusMessage {
  /** Message body, JSON-decoded when it is JSON. */
  body: unknown;
  /** Message ID. */
  messageId: string | undefined;
  /** How many times delivery was attempted (1 on first delivery). */
  deliveryCount: number | undefined;
  /** When Service Bus accepted the message. */
  enqueuedTimeUtc: string | undefined;
  /** Application properties set by the sender. */
  applicationProperties: Record<string, unknown>;
  /** All trigger metadata the host passed (`SequenceNumber`, `ContentType`, …). */
  metadata: Record<string, unknown>;
}

export interface ServiceBusEventSourceProps {
  /**
   * Name of the trigger function on the host (letters, digits, `_`, `-`).
   * @default `sbq-<queue logical ID>` / `sbs-<subscription logical ID>`
   */
  functionName?: string;
}

export type QueueEventSourceService = <Req = never>(
  queue: Queue,
  props: ServiceBusEventSourceProps,
  handler: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source connecting a Service Bus {@link Queue} to the runtime that
 * hosts it. Consume it with {@link consumeQueueMessages} and provide the
 * host's implementation: `Azure.Functions.ServiceBusQueueEventSource` (a
 * native `serviceBusTrigger` function with a managed-identity connection).
 *
 * The host completes a message when the handler succeeds and abandons it
 * when the handler fails (defects); after the queue's max delivery count
 * the message moves to the dead-letter queue.
 *
 * ### Consuming a Queue
 * **Example:** Process orders in an Azure Function
 * ```typescript
 * yield* Azure.ServiceBus.consumeQueueMessages(orders, (message) =>
 *   Effect.log(`order ${message.messageId}`),
 * );
 * // …provided with Effect.provide(Azure.Functions.ServiceBusQueueEventSource)
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface QueueEventSource extends Binding.Service<
  QueueEventSource,
  "Azure.ServiceBus.QueueEventSource",
  QueueEventSourceService
> {}

export const QueueEventSource = Binding.Service<QueueEventSource>(
  "Azure.ServiceBus.QueueEventSource",
);

/**
 * Run `handler` for every message sent to the Service Bus `queue`.
 *
 * @example
 * ```typescript
 * yield* Azure.ServiceBus.consumeQueueMessages(orders, (message) => Effect.log(message.body));
 * ```
 */
export function consumeQueueMessages<Q extends Queue, Req = never, QueueReq = never>(
  queue: Q | Effect.Effect<Q, never, QueueReq>,
  handler: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, QueueEventSource | QueueReq>;
export function consumeQueueMessages<Q extends Queue, Req = never, QueueReq = never>(
  queue: Q | Effect.Effect<Q, never, QueueReq>,
  props: ServiceBusEventSourceProps,
  handler: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, QueueEventSource | QueueReq>;
export function consumeQueueMessages<Q extends Queue, Req = never, QueueReq = never>(
  queue: Q | Effect.Effect<Q, never, QueueReq>,
  propsOrHandler:
    | ServiceBusEventSourceProps
    | ((message: ServiceBusMessage) => Effect.Effect<void, never, Req>),
  maybeHandler?: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, QueueEventSource | QueueReq> {
  const [props, handler] =
    typeof propsOrHandler === "function"
      ? [{} as ServiceBusEventSourceProps, propsOrHandler]
      : [propsOrHandler, maybeHandler!];
  const resolved = Effect.isEffect(queue) ? queue : Effect.succeed(queue);
  return resolved.pipe(
    Effect.flatMap((value) => QueueEventSource.use((source) => source(value, props, handler))),
  );
}
