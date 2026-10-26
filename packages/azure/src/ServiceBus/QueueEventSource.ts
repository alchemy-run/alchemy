import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** One Service Bus message delivered to a handler. */
export interface ServiceBusMessage {
  /** Message body: JSON-decoded when it is JSON, else the text. */
  body: unknown;
  /** Message ID. */
  messageId: string | undefined;
  /** How many times delivery was attempted (1 on first delivery). */
  deliveryCount: number | undefined;
  /** When Service Bus accepted the message (UTC). */
  enqueuedTimeUtc: string | undefined;
  /** Application (custom) properties the sender set, by name. */
  applicationProperties: Record<string, unknown>;
  /** All trigger metadata the host passed (`SequenceNumber`, `ContentType`, …). */
  metadata: Record<string, unknown>;
}

/** Options of a Service Bus event source. */
export interface ServiceBusEventSourceProps {
  /**
   * Name of the trigger function on an Azure Function host (letters,
   * digits, `_`, `-`). Container Apps hosts ignore it.
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
 * Run a handler for every message sent to an Azure Service Bus
 * {@link Queue}. Consume it with {@link consumeQueueMessages} inside the
 * host and provide the host's layer:
 *
 * - **Azure Function**: `Azure.Functions.ServiceBusQueueEventSource`. It
 *   adds a native `serviceBusTrigger` function with a managed-identity
 *   connection and assigns **Azure Service Bus Data Receiver** on the queue
 *   only.
 * - **Container App**: `Azure.ContainerApps.AppServiceBusQueueEventSource`.
 *   It adds a KEDA `azure-servicebus` scale rule and runs a receive loop in
 *   every replica. It assigns **Azure Service Bus Data Owner** on the queue
 *   only, because the KEDA scaler reads the queue's message count.
 * - **Container Apps job**: `Azure.ContainerApps.JobServiceBusQueueEventSource`.
 *   A KEDA rule starts an execution while the queue has messages. It
 *   assigns **Azure Service Bus Data Owner** on the queue only.
 *
 * The host completes a message when the handler succeeds and abandons it
 * when the handler fails (defects). After the queue's max delivery count
 * the message moves to the dead-letter queue. Make the handler idempotent:
 * a message can arrive more than once.
 *
 * ### Consuming a Queue
 * **Example:** Process orders in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: adds the trigger and assigns the role on the queue only
 *     yield* Azure.ServiceBus.consumeQueueMessages(Orders, (message) =>
 *       // runtime: once per message
 *       Effect.log(`order ${message.messageId}: ${JSON.stringify(message.body)}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.ServiceBusQueueEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Process orders in a Container App
 * ```typescript
 * export default class Worker extends Azure.ContainerApps.ContainerApp<Worker>()(
 *   "Worker",
 *   Effect.gen(function* () {
 *     const env = yield* Environment;
 *     return {
 *       main: import.meta.url,
 *       environmentId: env.environmentId,
 *       template: { scale: { minReplicas: 0, maxReplicas: 5 } },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     yield* Azure.ServiceBus.consumeQueueMessages(Orders, (message) =>
 *       Effect.log(`order ${message.messageId}, delivery ${message.deliveryCount}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerApps.AppServiceBusQueueEventSource)),
 * ) {}
 * ```
 *
 * ### Naming the Trigger
 * **Example:** Set the Azure Function trigger name
 * ```typescript
 * yield* Azure.ServiceBus.consumeQueueMessages(
 *   Orders,
 *   { functionName: "process-orders" },
 *   (message) => Effect.log(message.body),
 * );
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
