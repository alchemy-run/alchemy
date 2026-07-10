import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Broker } from "./Broker.ts";

/**
 * A single message delivered by an Amazon MQ event source. The shape differs
 * slightly between ActiveMQ (`aws:mq`) and RabbitMQ (`aws:rmq`) — the common
 * fields are typed here and the raw payload is available for engine-specific
 * access.
 */
export interface MQMessage {
  /** Base64-encoded message body. */
  readonly data?: string;
  /** ActiveMQ message id. */
  readonly messageID?: string;
  /** ActiveMQ message type (e.g. `jms/text-message`). */
  readonly messageType?: string;
  /** ActiveMQ destination the message was published to. */
  readonly destination?: { readonly physicalName?: string };
  /** Whether the message was redelivered. */
  readonly redelivered?: boolean;
  /** RabbitMQ basic properties. */
  readonly basicProperties?: Record<string, unknown>;
  /** Any additional engine-specific fields. */
  readonly [key: string]: unknown;
}

/**
 * The raw ActiveMQ (`aws:mq`) event Lambda receives.
 */
export interface ActiveMQEvent {
  readonly eventSource: "aws:mq";
  readonly eventSourceArn: string;
  readonly messages: MQMessage[];
}

/**
 * The raw RabbitMQ (`aws:rmq`) event Lambda receives.
 */
export interface RabbitMQEvent {
  readonly eventSource: "aws:rmq";
  readonly eventSourceArn: string;
  readonly rmqMessagesByQueue: { readonly [queue: string]: MQMessage[] };
}

export type MQEvent = ActiveMQEvent | RabbitMQEvent;

export interface BrokerEventSourceProps {
  /**
   * Destination queue name(s) on the broker to consume. ActiveMQ supports a
   * single queue; RabbitMQ supports multiple.
   */
  queues: string[];
  /**
   * ARN of a Secrets Manager secret holding the broker credentials as
   * `{ "username": "...", "password": "..." }`. Lambda uses these
   * (`BASIC_AUTH`) to connect to the broker.
   */
  credentialsSecretArn: string;
  /**
   * The maximum number of messages in each batch that Lambda pulls from the
   * broker.
   * @default 100
   */
  batchSize?: number;
  /**
   * The maximum time, in seconds, Lambda spends gathering records before
   * invoking the function.
   */
  maximumBatchingWindowInSeconds?: number;
  /**
   * Whether the event source mapping is active.
   * @default true
   */
  enabled?: boolean;
}

type MessagesHandler<Req> = (
  stream: Stream.Stream<MQMessage>,
) => Effect.Effect<void, never, Req>;

/**
 * Subscribe an Effect handler to messages produced by an Amazon MQ
 * {@link Broker}. Lambda polls the named broker queue(s) using the supplied
 * Secrets Manager credentials and invokes the handler with a stream of
 * messages.
 *
 * @param broker The Amazon MQ broker to consume from.
 * @param props Queues, credentials secret, and batching configuration.
 * @param process The handler invoked with a stream of MQ messages.
 */
export function consumeBrokerMessages<B extends Broker, Req = never>(
  broker: B,
  props: BrokerEventSourceProps,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, BrokerEventSource> {
  return BrokerEventSource.use((source) => source(broker, props, process));
}

export class BrokerEventSource extends Context.Service<
  BrokerEventSource,
  BrokerEventSourceService
>()("AWS.MQ.BrokerEventSource") {}

export type BrokerEventSourceService = <Req = never>(
  broker: Broker,
  props: BrokerEventSourceProps,
  process: (
    stream: Stream.Stream<MQMessage>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
