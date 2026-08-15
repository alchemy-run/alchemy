import * as Data from "effect/Data";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";

/**
 * Shared types and tagged errors for the Vercel Queues data plane
 * (`https://{region}.vercel-queue.com/api/v3`).
 *
 * The HTTP surface behind these lives in distilled's generated
 * `queues_data` service (manual-spec data plane); `QueueData.ts` adapts the
 * generated error taxonomy onto these public classes, which carry the
 * `operation`/`topic`/`id` context the generated ones don't.
 */

/** Metadata delivered with every received message (the `Vqs-*` part headers). */
export interface QueueMessageMeta {
  /** Unique message id (`Vqs-Message-Id`). */
  readonly messageId: string;
  /** Delivery attempt count for this consumer group (`Vqs-Delivery-Count`). */
  readonly deliveryCount: number;
  /** When the message was enqueued (`Vqs-Timestamp`). */
  readonly createdAt: Date;
  /** When the message expires (`Vqs-Expires-At`), if reported. */
  readonly expiresAt?: Date | undefined;
  /** Payload content type (`Content-Type` of the multipart part). */
  readonly contentType: string;
  /**
   * Lease handle for this delivery (`Vqs-Receipt-Handle`) — pass to
   * `ack`/`extendLease`. Scoped to the consumer group and delivery.
   */
  readonly receiptHandle: string;
}

/** A received message: delivery metadata plus the schema-decoded payload. */
export interface ReceivedMessage<A> extends QueueMessageMeta {
  readonly payload: A;
}

/**
 * Metadata handed to a `subscribe` handler alongside the schema-decoded
 * payload — the per-message `Vqs-*` metadata plus the routing identity of
 * the push delivery (which topic, under which consumer group).
 */
export interface QueueDeliveryMeta extends QueueMessageMeta {
  /** The topic the message was delivered from. */
  readonly topicName: string;
  /** The consumer group this delivery is leased under. */
  readonly consumerGroup: string;
}

/** Receipt returned by a successful send (202 responses carry no id). */
export interface SendReceipt {
  readonly messageId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No ambient OIDC token was found. Inside a Vercel Function the platform
 * provisions one (request-context header `x-vercel-oidc-token`, or the
 * `VERCEL_OIDC_TOKEN` env var); outside Vercel, mint one with
 * `mintProjectOidcToken`/`projectOidcToken` or pass `token` explicitly.
 */
export class MissingOidcToken extends Data.TaggedError(
  "Vercel.Queues.MissingOidcToken",
)<{
  readonly message: string;
}> {}

/** Minting a project OIDC token via the management API failed. */
export class OidcTokenMintFailed extends Data.TaggedError(
  "Vercel.Queues.OidcTokenMintFailed",
)<{
  readonly message: string;
  readonly projectIdOrName: string;
  readonly cause: unknown;
}> {}

/**
 * The topic partitions by deployment but no deployment id could be resolved
 * (no `VERCEL_DEPLOYMENT_ID` in the environment and none passed explicitly).
 * Deployment pinning is load-bearing on Vercel queues: unpinned sends are
 * invisible to pinned receivers and vice versa.
 */
export class MissingDeploymentId extends Data.TaggedError(
  "Vercel.Queues.MissingDeploymentId",
)<{
  readonly message: string;
  readonly topic: string;
}> {}

// ─────────────────────────────────────────────────────────────────────────────
// Data-plane errors (status-mapped, mirroring the documented protocol)
// ─────────────────────────────────────────────────────────────────────────────

/** 400 — invalid parameters (bad visibility timeout, malformed request, …). */
export class QueueBadRequest extends Data.TaggedError(
  "Vercel.Queues.QueueBadRequest",
)<{
  readonly message: string;
  readonly operation: string;
  readonly topic: string;
}> {}

/** 401 — the OIDC bearer token is missing, expired, or invalid. */
export class QueueUnauthorized extends Data.TaggedError(
  "Vercel.Queues.QueueUnauthorized",
)<{
  readonly message: string;
  readonly operation: string;
  readonly topic: string;
}> {}

/** 403 — the token is valid but not allowed to access this topic. */
export class QueueForbidden extends Data.TaggedError(
  "Vercel.Queues.QueueForbidden",
)<{
  readonly message: string;
  readonly operation: string;
  readonly topic: string;
}> {}

/** 429 — rate limited; `retryAfterSeconds` is parsed from `Retry-After`. */
export class QueueRateLimited extends Data.TaggedError(
  "Vercel.Queues.QueueRateLimited",
)<{
  readonly message: string;
  readonly operation: string;
  readonly topic: string;
  readonly retryAfterSeconds?: number | undefined;
}> {}

/** 5xx (or an unexpected status) from the queue data plane. */
export class QueueInternalError extends Data.TaggedError(
  "Vercel.Queues.QueueInternalError",
)<{
  readonly message: string;
  readonly operation: string;
  readonly topic: string;
  readonly status: number;
}> {}

/** 409 on send — the `Vqs-Idempotency-Key` was already used. */
export class DuplicateMessage extends Data.TaggedError(
  "Vercel.Queues.DuplicateMessage",
)<{
  readonly message: string;
  readonly topic: string;
  readonly idempotencyKey?: string | undefined;
}> {}

/** 502 on send — the platform could not discover a consumer for the topic. */
export class ConsumerDiscoveryFailed extends Data.TaggedError(
  "Vercel.Queues.ConsumerDiscoveryFailed",
)<{
  readonly message: string;
  readonly topic: string;
  readonly deploymentId?: string | undefined;
}> {}

/**
 * 503 on send — the project has no consumer registry configured (no
 * deployment carries a queue trigger for this topic yet).
 */
export class ConsumerRegistryNotConfigured extends Data.TaggedError(
  "Vercel.Queues.ConsumerRegistryNotConfigured",
)<{
  readonly message: string;
  readonly topic: string;
}> {}

/** 404 — no such message (or receipt handle) for this consumer group. */
export class MessageNotFound extends Data.TaggedError(
  "Vercel.Queues.MessageNotFound",
)<{
  readonly message: string;
  readonly topic: string;
  readonly id: string;
}> {}

/**
 * 409 — the message exists but is not in a receivable/ackable state for this
 * consumer group (already leased, wrong receipt handle, or a duplicate whose
 * `originalMessageId` should be used instead).
 */
export class MessageNotAvailable extends Data.TaggedError(
  "Vercel.Queues.MessageNotAvailable",
)<{
  readonly message: string;
  readonly topic: string;
  readonly id: string;
  readonly originalMessageId?: string | undefined;
}> {}

/** 410 — the message was already processed by this consumer group. */
export class MessageAlreadyProcessed extends Data.TaggedError(
  "Vercel.Queues.MessageAlreadyProcessed",
)<{
  readonly message: string;
  readonly topic: string;
  readonly id: string;
}> {}

/** A multipart part (or payload) that could not be parsed as a message. */
export class QueueMessageCorrupted extends Data.TaggedError(
  "Vercel.Queues.QueueMessageCorrupted",
)<{
  readonly message: string;
  readonly topic: string;
  readonly id?: string | undefined;
}> {}

// ─────────────────────────────────────────────────────────────────────────────
// Error unions per operation
// ─────────────────────────────────────────────────────────────────────────────

/** Token resolution errors (ambient lookup or management-API mint). */
export type OidcTokenError = MissingOidcToken | OidcTokenMintFailed;

/** Errors shared by every data-plane operation. */
export type QueueCommonError =
  | QueueBadRequest
  | QueueUnauthorized
  | QueueForbidden
  | QueueRateLimited
  | QueueInternalError
  | HttpClientError.HttpClientError;

export type SendMessageError =
  | OidcTokenError
  | MissingDeploymentId
  | DuplicateMessage
  | ConsumerDiscoveryFailed
  | ConsumerRegistryNotConfigured
  | QueueCommonError;

export type ReceiveMessagesError =
  | OidcTokenError
  | MissingDeploymentId
  | QueueMessageCorrupted
  | QueueCommonError;

export type ReceiveMessageByIdError =
  | ReceiveMessagesError
  | MessageNotFound
  | MessageNotAvailable
  | MessageAlreadyProcessed;

export type AcknowledgeMessageError =
  | OidcTokenError
  | MissingDeploymentId
  | MessageNotFound
  | MessageNotAvailable
  | QueueCommonError;

export type ExtendLeaseError = AcknowledgeMessageError;
