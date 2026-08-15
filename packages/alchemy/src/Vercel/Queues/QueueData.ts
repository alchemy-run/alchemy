import * as QueuesData from "@distilled.cloud/vercel/queues_data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  ConsumerDiscoveryFailed,
  ConsumerRegistryNotConfigured,
  DuplicateMessage,
  MessageAlreadyProcessed,
  MessageNotAvailable,
  MessageNotFound,
  QueueBadRequest,
  QueueForbidden,
  QueueInternalError,
  QueueMessageCorrupted,
  QueueRateLimited,
  QueueUnauthorized,
  type QueueCommonError,
  type QueueMessageMeta,
} from "./QueueTypes.ts";

/**
 * Boundary between the queue capabilities and the DISTILLED Vercel Queues
 * data plane (`@distilled.cloud/vercel/queues_data`, generated from
 * `manual-specs/`). All HTTP — hosts, `Vqs-*` headers, OIDC bearer, the
 * `VERCEL_QUEUE_BASE_URL` local-broker override, multipart/mixed parsing —
 * lives in the generated operations; this module only adapts shapes:
 *
 * - timestamps: generated ops return ISO strings → the public
 *   `QueueMessageMeta` carries `Date`s
 * - errors: generated tags (`QueueBadRequest`, `MessageNotFound`, core
 *   status errors, …) → the public `Vercel.Queues.*` taxonomy, which carries
 *   `operation`/`topic`/`id` context the generated classes don't
 * - `sendMessage`'s absent `messageId` (202) → the public `null`
 * - `receiveMessageById`'s empty batch (no valid part) → the public
 *   `QueueMessageCorrupted`
 *
 * INTERNAL scaffolding — NOT exported from the Vercel `index.ts`. The public
 * surface is the `SendMessage`/`ReceiveMessages` capabilities.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Request/response shapes (unchanged public-internal contract)
// ─────────────────────────────────────────────────────────────────────────────

export interface QueueRequestBase {
  /** Region host to hit (`https://{region}.vercel-queue.com`). */
  readonly region: string;
  /** Topic (queue) name. */
  readonly topic: string;
  /** OIDC bearer token. */
  readonly token: Redacted.Redacted<string>;
  /** Deployment partition pin (`Vqs-Deployment-Id`); omitted when undefined. */
  readonly deploymentId?: string | undefined;
}

/** A received message with its raw (not yet schema-decoded) payload bytes. */
export interface RawQueueMessage extends QueueMessageMeta {
  readonly payload: Uint8Array;
}

/** Generated message record (ISO timestamps) → the Date-carrying meta shape. */
const toRawMessage = (message: QueuesData.QueueMessage): RawQueueMessage => ({
  messageId: message.messageId,
  deliveryCount: message.deliveryCount,
  createdAt: new Date(message.createdAt),
  expiresAt:
    message.expiresAt !== undefined ? new Date(message.expiresAt) : undefined,
  contentType: message.contentType,
  receiptHandle: message.receiptHandle,
  payload: message.payload,
});

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping (generated taxonomy → public Vercel.Queues.* taxonomy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The error channel every generated queues_data op shares: its typed
 * status errors plus the distilled default/client errors.
 */
type DataPlaneCommonError =
  | QueuesData.QueueBadRequest
  | QueuesData.QueueUnauthorized
  | QueuesData.QueueForbidden
  | QueuesData.VercelDataOpError;

/** Statuses of the core/default error tags QueueInternalError absorbs. */
const STATUS_BY_TAG: Record<string, number> = {
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
  Gone: 410,
  PaymentRequired: 402,
};

/** Recover a status from the protocol's `HTTP <status>` fallback message. */
const statusFromMessage = (message: string | undefined): number | undefined => {
  if (message === undefined) return undefined;
  const match = /^HTTP (\d{3})\b/.exec(message);
  return match !== null ? Number(match[1]) : undefined;
};

/**
 * Map the errors shared by every data-plane op onto the public taxonomy,
 * stamping the `operation`/`topic` context the public classes carry.
 * Op-specific tags (DuplicateMessage, MessageNotFound, …) must be handled
 * BEFORE falling through to this.
 */
const mapCommonError = (
  operation: string,
  topic: string,
  error: DataPlaneCommonError,
): QueueCommonError => {
  switch (error._tag) {
    // Transport failures pass through — they are part of the public union.
    case "HttpClientError":
      return error;
    case "QueueBadRequest":
      return new QueueBadRequest({ message: error.message, operation, topic });
    case "QueueUnauthorized":
    case "Unauthorized":
      return new QueueUnauthorized({
        message: error.message,
        operation,
        topic,
      });
    case "QueueForbidden":
      return new QueueForbidden({ message: error.message, operation, topic });
    case "TooManyRequests":
      return new QueueRateLimited({
        message: error.message,
        operation,
        topic,
        retryAfterSeconds:
          error.retryAfter !== undefined
            ? Duration.toSeconds(error.retryAfter)
            : undefined,
      });
    case "VercelParseError":
      return new QueueInternalError({
        message: `response decode failed: ${String(error.cause)}`,
        operation,
        topic,
        status: 0,
      });
    default: {
      const message = error.message ?? `Vercel queue error (${error._tag})`;
      return new QueueInternalError({
        message,
        operation,
        topic,
        status: STATUS_BY_TAG[error._tag] ?? statusFromMessage(message) ?? 0,
      });
    }
  }
};

/**
 * Best-effort recovery of `originalMessageId` from a 409 body — the
 * generated `MessageNotAvailable` doesn't model it as a field, and the
 * broker's `{ message, originalMessageId }` JSON body only survives into the
 * error message when it isn't envelope-shaped, so this is advisory only.
 */
const parseOriginalMessageId = (message: string): string | undefined => {
  try {
    const parsed = JSON.parse(message) as { originalMessageId?: string };
    return typeof parsed.originalMessageId === "string"
      ? parsed.originalMessageId
      : undefined;
  } catch {
    return undefined;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

export interface SendMessageRawOptions extends QueueRequestBase {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly idempotencyKey?: string | undefined;
  readonly retentionSeconds?: number | undefined;
  readonly delaySeconds?: number | undefined;
}

/** Enqueue one message (POST /api/v3/topic/{topic}). */
export const sendMessageRaw = Effect.fn("Vercel.Queues.sendMessage")(function* (
  options: SendMessageRawOptions,
) {
  const response = yield* QueuesData.sendMessage({
    region: options.region,
    token: options.token,
    topic: options.topic,
    deploymentId: options.deploymentId,
    contentType: options.contentType,
    idempotencyKey: options.idempotencyKey,
    retentionSeconds: options.retentionSeconds,
    delaySeconds: options.delaySeconds,
    payload: options.body,
  }).pipe(
    Effect.mapError((error) => {
      switch (error._tag) {
        case "DuplicateMessage":
          return new DuplicateMessage({
            message: error.message,
            topic: options.topic,
            idempotencyKey: options.idempotencyKey,
          });
        case "ConsumerDiscoveryFailed":
          return new ConsumerDiscoveryFailed({
            message: error.message,
            topic: options.topic,
            deploymentId: options.deploymentId,
          });
        case "ConsumerRegistryNotConfigured":
          return new ConsumerRegistryNotConfigured({
            message: error.message,
            topic: options.topic,
          });
        default:
          return mapCommonError("send message", options.topic, error);
      }
    }),
  );
  // A 202 carries no id — the public receipt models that as null.
  return { messageId: response.messageId ?? null } as const;
});

export interface ReceiveMessagesRawOptions extends QueueRequestBase {
  readonly consumerGroup: string;
  readonly visibilityTimeoutSeconds?: number | undefined;
  /** 1–10 (`Vqs-Max-Messages`). */
  readonly maxMessages?: number | undefined;
}

/** Lease a batch (POST /api/v3/topic/{topic}/consumer/{consumerGroup}). */
export const receiveMessagesRaw = Effect.fn("Vercel.Queues.receiveMessages")(
  function* (options: ReceiveMessagesRawOptions) {
    // Parts missing required Vqs-* headers are skipped inside the generated
    // op (they stay leased and expire back), mirroring @vercel/queue.
    const response = yield* QueuesData.receiveMessages({
      region: options.region,
      token: options.token,
      topic: options.topic,
      consumerGroup: options.consumerGroup,
      deploymentId: options.deploymentId,
      visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
      maxMessages: options.maxMessages,
    }).pipe(
      Effect.mapError((error) =>
        mapCommonError("receive messages", options.topic, error),
      ),
    );
    return response.messages.map(toRawMessage);
  },
);

export interface ReceiveMessageByIdRawOptions extends QueueRequestBase {
  readonly consumerGroup: string;
  readonly messageId: string;
  readonly visibilityTimeoutSeconds?: number | undefined;
}

/** Lease one message by id (POST .../consumer/{consumerGroup}/id/{messageId}). */
export const receiveMessageByIdRaw = Effect.fn(
  "Vercel.Queues.receiveMessageById",
)(function* (options: ReceiveMessageByIdRawOptions) {
  const response = yield* QueuesData.receiveMessageById({
    region: options.region,
    token: options.token,
    topic: options.topic,
    consumerGroup: options.consumerGroup,
    messageId: options.messageId,
    deploymentId: options.deploymentId,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
  }).pipe(
    Effect.mapError((error) => {
      switch (error._tag) {
        case "MessageNotFound":
          return new MessageNotFound({
            message: error.message,
            topic: options.topic,
            id: options.messageId,
          });
        case "MessageNotAvailable":
          return new MessageNotAvailable({
            message: error.message,
            topic: options.topic,
            id: options.messageId,
            originalMessageId: parseOriginalMessageId(error.message),
          });
        case "MessageAlreadyProcessed":
          return new MessageAlreadyProcessed({
            message: error.message,
            topic: options.topic,
            id: options.messageId,
          });
        default:
          return mapCommonError("receive message by id", options.topic, error);
      }
    }),
  );
  const first = response.messages[0];
  if (first === undefined) {
    // A 2xx whose parts all lacked the required Vqs-* headers — the old
    // "no valid message part" corruption case.
    return yield* new QueueMessageCorrupted({
      message: `Message ${options.messageId}: response carried no valid message part`,
      topic: options.topic,
      id: options.messageId,
    });
  }
  return toRawMessage(first);
});

export interface LeaseRawOptions extends QueueRequestBase {
  readonly consumerGroup: string;
  readonly receiptHandle: string;
}

type LeaseError = QueuesData.AcknowledgeMessageError;

const mapLeaseError =
  (
    operation: string,
    options: LeaseRawOptions,
  ): ((
    error: LeaseError,
  ) => QueueCommonError | MessageNotFound | MessageNotAvailable) =>
  (error) => {
    switch (error._tag) {
      case "MessageNotFound":
        return new MessageNotFound({
          message: error.message,
          topic: options.topic,
          id: options.receiptHandle,
        });
      case "MessageNotAvailable":
        return new MessageNotAvailable({
          message: error.message,
          topic: options.topic,
          id: options.receiptHandle,
        });
      default:
        return mapCommonError(operation, options.topic, error);
    }
  };

/** Acknowledge (complete) a delivery (DELETE .../lease/{receiptHandle}). */
export const acknowledgeMessageRaw = Effect.fn(
  "Vercel.Queues.acknowledgeMessage",
)(function* (options: LeaseRawOptions) {
  yield* QueuesData.acknowledgeMessage({
    region: options.region,
    token: options.token,
    topic: options.topic,
    consumerGroup: options.consumerGroup,
    receiptHandle: options.receiptHandle,
    deploymentId: options.deploymentId,
  }).pipe(Effect.mapError(mapLeaseError("acknowledge message", options)));
});

export interface ExtendLeaseRawOptions extends LeaseRawOptions {
  readonly visibilityTimeoutSeconds: number;
}

/** Extend a delivery's visibility timeout (PATCH .../lease/{receiptHandle}). */
export const extendLeaseRaw = Effect.fn("Vercel.Queues.extendLease")(function* (
  options: ExtendLeaseRawOptions,
) {
  yield* QueuesData.extendLease({
    region: options.region,
    token: options.token,
    topic: options.topic,
    consumerGroup: options.consumerGroup,
    receiptHandle: options.receiptHandle,
    deploymentId: options.deploymentId,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
  }).pipe(Effect.mapError(mapLeaseError("extend lease", options)));
});
