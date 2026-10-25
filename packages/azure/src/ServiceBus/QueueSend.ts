import type { SendMessageError } from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

export interface ServiceBusSendOptions {
  /** `Content-Type` of the body. @default "application/json" for objects, else "text/plain" */
  contentType?: string;
  /** Message ID, used for duplicate detection. */
  messageId?: string;
  /** Session ID; required by session-enabled queues. */
  sessionId?: string;
  correlationId?: string;
  /** Message label (subject). */
  label?: string;
  /** Time to live in seconds. */
  timeToLiveSeconds?: number;
  /** Application properties, sent as custom headers. */
  properties?: Record<string, string>;
}

/** Send-only client for one Service Bus queue. */
export interface SendServiceBusQueueClient {
  /** Send one message; objects are JSON-encoded. */
  send(
    body: string | object,
    options?: ServiceBusSendOptions,
  ): Effect.Effect<void, SendMessageError, RuntimeContext>;
}

/**
 * Send messages to an Azure Service Bus queue from any host.
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
 * // init
 * const orders = yield* Azure.ServiceBus.QueueSend(queue);
 *
 * // runtime
 * yield* orders.send({ orderId }, { messageId: orderId });
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
