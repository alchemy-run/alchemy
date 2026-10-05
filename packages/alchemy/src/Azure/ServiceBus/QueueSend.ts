import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type {
  AzureDataPlaneError,
  AzureManagedIdentityError,
} from "../Binding.ts";
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
  ): Effect.Effect<
    void,
    AzureDataPlaneError | AzureManagedIdentityError,
    RuntimeContext
  >;
}

/**
 * Send messages to an Azure Service Bus queue from a Container App or
 * Function App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Azure Service Bus Data Sender** on the queue only. Provide
 * {@link QueueSendHttp}.
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

export const QueueSend = Binding.Service<QueueSend>(
  "Azure.ServiceBus.QueueSend",
);
