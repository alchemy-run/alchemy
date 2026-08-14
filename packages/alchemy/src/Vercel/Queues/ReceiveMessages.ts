import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  acknowledgeMessageRaw,
  extendLeaseRaw,
  receiveMessageByIdRaw,
  receiveMessagesRaw,
  type RawQueueMessage,
} from "./QueueApi.ts";
import {
  resolveQueueDeploymentId,
  resolveQueueToken,
  type QueueClientOptions,
} from "./QueueClient.ts";
import {
  QueueMessageCorrupted,
  type AcknowledgeMessageError,
  type ExtendLeaseError,
  type ReceiveMessageByIdError,
  type ReceiveMessagesError,
  type ReceivedMessage,
} from "./QueueTypes.ts";
import type { Topic } from "./Topic.ts";

const textDecoder = new TextDecoder();

/** Consumer-group identity (and shared receive defaults) for a client. */
export interface ReceiveMessagesOptions {
  /**
   * Consumer group to receive under. Groups are dynamic — a fresh group
   * replays the topic from the beginning (live-verified); each group has its
   * own cursor, leases, and acks.
   */
  readonly consumerGroup: string;
  /** Default visibility timeout (seconds) applied to every receive. */
  readonly visibilityTimeoutSeconds?: number;
}

/** Per-receive overrides. */
export interface ReceiveOptions {
  /** Max messages per receive, 1–10 (`Vqs-Max-Messages`). */
  readonly maxMessages?: number;
  /** Visibility timeout (seconds) for the returned leases. */
  readonly visibilityTimeoutSeconds?: number;
}

/**
 * Poll-mode consumer client for a {@link Topic}: bounded receives under a
 * consumer group, plus lease management (`ack` / `extendLease`). Payloads
 * are decoded with the topic's schema.
 */
export interface ReceiveMessagesClient<
  S extends Schema.Top = Schema.Top,
  R = never,
> {
  readonly topic: Topic<S>;
  readonly consumerGroup: string;
  /** One bounded receive (single request, ≤10 messages) — never a long poll. */
  readonly receive: (
    options?: ReceiveOptions,
  ) => Effect.Effect<
    ReadonlyArray<ReceivedMessage<S["Type"]>>,
    ReceiveMessagesError | Schema.SchemaError,
    R | S["DecodingServices"]
  >;
  /** Receive one specific message by id (leases it like `receive`). */
  readonly receiveById: (
    messageId: string,
    options?: Pick<ReceiveOptions, "visibilityTimeoutSeconds">,
  ) => Effect.Effect<
    ReceivedMessage<S["Type"]>,
    ReceiveMessageByIdError | Schema.SchemaError,
    R | S["DecodingServices"]
  >;
  /** Acknowledge (complete) a delivery — the message is not redelivered to this group. */
  readonly ack: (
    receiptHandle: string,
  ) => Effect.Effect<void, AcknowledgeMessageError, R>;
  /** Extend (or shrink) the current lease's visibility timeout. */
  readonly extendLease: (
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ) => Effect.Effect<void, ExtendLeaseError, R>;
}

/**
 * Receive typed messages from a Vercel queue {@link Topic} in poll mode —
 * consumer-group receive + ack + lease extension, for infrastructure that
 * runs OUTSIDE Vercel's push delivery (external workers, tests, other
 * clouds' runtimes). Push consumption inside a deployed Function is the
 * `subscribe` event source (separate wave).
 *
 * Provide the implementation with
 * `Effect.provide(Vercel.ReceiveMessagesHttp)`; outside a Function build the
 * client directly with {@link makeReceiveMessagesClient}.
 *
 * @binding
 * @section Receiving Messages
 * @example Poll, process, acknowledge
 * ```typescript
 * const token = yield* Vercel.projectOidcToken(project.projectId);
 * const consumer = yield* Vercel.makeReceiveMessagesClient(Orders, {
 *   consumerGroup: "worker",
 *   token,
 *   deploymentId: deployment.deploymentId,
 * });
 * const messages = yield* consumer.receive({ maxMessages: 10 });
 * for (const message of messages) {
 *   yield* process(message.payload);
 *   yield* consumer.ack(message.receiptHandle);
 * }
 * ```
 *
 * @example Holding a lease across slow work
 * ```typescript
 * const [message] = yield* consumer.receive({ visibilityTimeoutSeconds: 30 });
 * yield* consumer.extendLease(message.receiptHandle, 300);
 * ```
 */
export interface ReceiveMessages extends Binding.Service<
  ReceiveMessages,
  "Vercel.ReceiveMessages",
  (
    topic: Topic<Schema.Top>,
    options: ReceiveMessagesOptions,
  ) => Effect.Effect<ReceiveMessagesClient<Schema.Top, RuntimeContext>>
> {
  <S extends Schema.Top>(
    topic: Topic<S>,
    options: ReceiveMessagesOptions,
  ): Effect.Effect<
    ReceiveMessagesClient<S, RuntimeContext>,
    never,
    ReceiveMessages
  >;
}

export const ReceiveMessages = Binding.Service<ReceiveMessages>(
  "Vercel.ReceiveMessages",
);

/** Decode one raw multipart message's payload with the topic's schema. */
const decodeMessage = <S extends Schema.Top>(
  topic: Topic<S>,
  raw: RawQueueMessage,
) =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: () => JSON.parse(textDecoder.decode(raw.payload)) as unknown,
      catch: (cause) =>
        new QueueMessageCorrupted({
          message: `Message ${raw.messageId}: payload is not valid JSON (${String(cause)})`,
          topic: topic.topicName,
          id: raw.messageId,
        }),
    });
    const payload = yield* Schema.decodeUnknownEffect(topic.schema)(json);
    return {
      messageId: raw.messageId,
      deliveryCount: raw.deliveryCount,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      contentType: raw.contentType,
      receiptHandle: raw.receiptHandle,
      payload,
    } as ReceivedMessage<S["Type"]>;
  });

/**
 * Build a {@link ReceiveMessagesClient} directly — the constructor for code
 * running OUTSIDE a deployed Function (tests, external poll workers), where
 * the OIDC token is minted (`mintProjectOidcToken` / `projectOidcToken`)
 * rather than ambient.
 */
export const makeReceiveMessagesClient = <S extends Schema.Top>(
  topic: Topic<S>,
  options: ReceiveMessagesOptions & QueueClientOptions,
): Effect.Effect<ReceiveMessagesClient<S>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    const base = Effect.gen(function* () {
      const token = yield* resolveQueueToken(options.token);
      const deploymentId = yield* resolveQueueDeploymentId(
        topic,
        options.deploymentId,
      );
      return {
        region: topic.region,
        topic: topic.topicName,
        consumerGroup: options.consumerGroup,
        token,
        deploymentId,
      };
    });

    const receive: ReceiveMessagesClient<S>["receive"] = Effect.fn(
      `Vercel.ReceiveMessages(${topic.topicName})`,
    )(function* (receiveOptions?: ReceiveOptions) {
      const raw = yield* Effect.flatMap(base, (common) =>
        receiveMessagesRaw({
          ...common,
          visibilityTimeoutSeconds:
            receiveOptions?.visibilityTimeoutSeconds ??
            options.visibilityTimeoutSeconds,
          maxMessages: receiveOptions?.maxMessages,
        }),
      ).pipe(Effect.provideContext(context));
      const messages: ReceivedMessage<S["Type"]>[] = [];
      for (const message of raw) {
        messages.push(yield* decodeMessage(topic, message));
      }
      return messages;
    }) as ReceiveMessagesClient<S>["receive"];

    const receiveById: ReceiveMessagesClient<S>["receiveById"] = Effect.fn(
      `Vercel.ReceiveMessages(${topic.topicName}).receiveById`,
    )(function* (
      messageId: string,
      receiveOptions?: Pick<ReceiveOptions, "visibilityTimeoutSeconds">,
    ) {
      const raw = yield* Effect.flatMap(base, (common) =>
        receiveMessageByIdRaw({
          ...common,
          messageId,
          visibilityTimeoutSeconds:
            receiveOptions?.visibilityTimeoutSeconds ??
            options.visibilityTimeoutSeconds,
        }),
      ).pipe(Effect.provideContext(context));
      return yield* decodeMessage(topic, raw);
    }) as ReceiveMessagesClient<S>["receiveById"];

    const ack: ReceiveMessagesClient<S>["ack"] = Effect.fn(
      `Vercel.ReceiveMessages(${topic.topicName}).ack`,
    )(function* (receiptHandle: string) {
      yield* Effect.flatMap(base, (common) =>
        acknowledgeMessageRaw({ ...common, receiptHandle }),
      ).pipe(Effect.provideContext(context));
    });

    const extendLease: ReceiveMessagesClient<S>["extendLease"] = Effect.fn(
      `Vercel.ReceiveMessages(${topic.topicName}).extendLease`,
    )(function* (receiptHandle: string, visibilityTimeoutSeconds: number) {
      yield* Effect.flatMap(base, (common) =>
        extendLeaseRaw({ ...common, receiptHandle, visibilityTimeoutSeconds }),
      ).pipe(Effect.provideContext(context));
    });

    return {
      topic,
      consumerGroup: options.consumerGroup,
      receive,
      receiveById,
      ack,
      extendLease,
    } satisfies ReceiveMessagesClient<S>;
  });
