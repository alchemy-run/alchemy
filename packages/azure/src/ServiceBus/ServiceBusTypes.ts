import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SendServiceBusQueueClient, ServiceBusSendOptions } from "./QueueSend.ts";

/** One message of {@link WriteServiceBusClient.sendBatch}. */
export interface ServiceBusBatchEntry {
  /** The payload; objects are JSON-encoded. */
  body: string | object;
  /** The message's broker and custom properties. */
  options?: ServiceBusSendOptions;
}

/** Send-only client for one Service Bus queue or topic. */
export interface WriteServiceBusClient extends SendServiceBusQueueClient {
  /**
   * Send several messages in one request (at most the namespace's maximum
   * message size, 256 KB on Standard, in total). An empty list sends
   * nothing.
   */
  sendBatch(
    messages: ReadonlyArray<ServiceBusBatchEntry>,
  ): Effect.Effect<void, messaging.SendMessageBatchError, RuntimeContext>;
}

/** Send-only client for one Service Bus queue. */
export interface WriteServiceBusQueueClient extends WriteServiceBusClient {}

/** Send-only client for one Service Bus topic. */
export interface WriteServiceBusTopicClient extends WriteServiceBusClient {}

/** One received Service Bus message. */
export interface ServiceBusReceivedMessage {
  /** The payload as sent. */
  body: Uint8Array;
  /** The payload decoded as UTF-8. */
  text: string;
  /** The content type stored with the message. */
  contentType: string | undefined;
  /** The message ID. */
  messageId: string | undefined;
  /** How many times the message was delivered (1 on the first delivery). */
  deliveryCount: number | undefined;
  /** When Service Bus accepted the message, RFC 1123. */
  enqueuedTimeUtc: string | undefined;
  /** Every broker property the service returned. */
  brokerProperties: messaging.BrokerProperties;
  /**
   * Every response header by lower-case name; the sender's custom
   * properties are among them, JSON-quoted (`"High"`).
   */
  headers: messaging.HeaderMap;
}

/** A peek-locked message: settle it with `complete`, `abandon` or `renewLock`. */
export interface ServiceBusLockedMessage extends ServiceBusReceivedMessage {
  /** The message reference of the lock URI (the sequence number, as text). */
  lockReference: string;
  /** The lock token. */
  lockToken: string;
  /** When the lock expires, RFC 1123. */
  lockedUntilUtc: string | undefined;
}

export interface ServiceBusReceiveOptions {
  /**
   * Seconds to wait for a message; without one in time the result is
   * `undefined`.
   * @default 5
   */
  timeoutSeconds?: number;
}

/** The lock a settle call needs: what `receive` returned. */
export type ServiceBusMessageLock = Pick<ServiceBusLockedMessage, "lockReference" | "lockToken">;

/** Receive-only client for one Service Bus queue or topic subscription. */
export interface ReceiveServiceBusClient {
  /**
   * Receive and lock the next message (peek-lock), or `undefined` when none
   * arrives within the timeout. Settle it before the lock expires.
   */
  receive(
    options?: ServiceBusReceiveOptions,
  ): Effect.Effect<
    ServiceBusLockedMessage | undefined,
    messaging.PeekLockMessageError,
    RuntimeContext
  >;
  /** Receive the next message and remove it in one step (at-most-once). */
  receiveAndDelete(
    options?: ServiceBusReceiveOptions,
  ): Effect.Effect<
    ServiceBusReceivedMessage | undefined,
    messaging.ReceiveAndDeleteMessageError,
    RuntimeContext
  >;
  /** Delete a locked message after processing succeeded. Fails `MessageLockLost` once the lock expired. */
  complete(
    message: ServiceBusMessageLock,
  ): Effect.Effect<void, messaging.CompleteMessageError, RuntimeContext>;
  /** Release a locked message so it is delivered again. */
  abandon(
    message: ServiceBusMessageLock,
  ): Effect.Effect<void, messaging.UnlockMessageError, RuntimeContext>;
  /** Extend the lock on a message by the entity's lock duration. */
  renewLock(
    message: ServiceBusMessageLock,
  ): Effect.Effect<void, messaging.RenewMessageLockError, RuntimeContext>;
}

/** Receive-only client for one Service Bus queue. */
export interface ReadServiceBusQueueClient extends ReceiveServiceBusClient {}

/** Receive-only client for one Service Bus topic subscription. */
export interface ReadServiceBusSubscriptionClient extends ReceiveServiceBusClient {}

/** Send, receive and settle client for one Service Bus queue. */
export interface ReadWriteServiceBusQueueClient
  extends ReadServiceBusQueueClient, WriteServiceBusQueueClient {}
