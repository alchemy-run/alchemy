import type { SendMessageError } from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** Broker and custom properties of one sent message. */
export interface ServiceBusSendOptions {
  /**
   * `Content-Type` stored with the message and returned on receive.
   * @default "application/json" for an object body, else "text/plain"
   */
  contentType?: string;
  /**
   * Message ID. Queues and topics with duplicate detection drop a second
   * message with the same ID.
   * @default an ID Service Bus generates
   */
  messageId?: string;
  /**
   * Session ID. Session-enabled queues and subscriptions require it.
   * @default no session
   */
  sessionId?: string;
  /**
   * Correlation ID, e.g. the ID of the request this message answers.
   * Correlation filters can match on it.
   * @default no correlation ID
   */
  correlationId?: string;
  /**
   * Message label (subject). Subscription rules often filter on it.
   * @default no label
   */
  label?: string;
  /**
   * Time to live in seconds. Service Bus expires the message after it.
   * @default the queue's or topic's default message time to live
   */
  timeToLiveSeconds?: number;
  /**
   * Application properties, sent as custom headers. A receiver gets them
   * back JSON-quoted (`"high"`).
   * @default {}
   */
  properties?: Record<string, string>;
}

/** Send-only client for one Service Bus queue. */
export interface SendServiceBusQueueClient {
  /**
   * Send one message. A string body is sent as it is; an object body is
   * JSON-encoded.
   */
  send(
    body: string | object,
    options?: ServiceBusSendOptions,
  ): Effect.Effect<void, SendMessageError, RuntimeContext>;
}

/**
 * Send messages, one at a time, to an Azure Service Bus queue from any
 * host. {@link QueueWrite} adds `sendBatch`.
 *
 * Binding assigns **Azure Service Bus Data Sender** on the queue only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity. On any other host (a Cloudflare Worker, an AWS
 * Lambda) Alchemy creates an Entra service principal for the host, assigns
 * the role to it, and binds its client secret into the host's env (see
 * `AzureBindings`). Provide {@link QueueSendHttp}.
 *
 * ### Sending Messages
 * **Example:** Send a JSON message
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue only
 *     const orders = yield* Azure.ServiceBus.QueueSend(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* orders.send({ orderId: "42" }, { messageId: "42" });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.QueueSendHttp)),
 * ) {}
 * ```
 *
 * **Example:** Send from a Container App
 * ```typescript
 * export default class Api extends Azure.ContainerApps.ContainerApp<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const env = yield* Environment;
 *     return { main: import.meta.url, environmentId: env.environmentId };
 *   }),
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     const orders = yield* Azure.ServiceBus.QueueSend(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.send("plain text", { label: "note", timeToLiveSeconds: 600 });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.QueueSendHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface QueueSend extends Binding.Service<
  QueueSend,
  "Azure.ServiceBus.QueueSend",
  (queue: Queue) => Effect.Effect<SendServiceBusQueueClient>
> {}

export const QueueSend = Binding.Service<QueueSend>("Azure.ServiceBus.QueueSend");
