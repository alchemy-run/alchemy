import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
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
 * Typed Effect client for the Vercel Queues data plane —
 * `https://{region}.vercel-queue.com/api/v3/topic/{topic}` with OIDC bearer
 * auth and `Vqs-*` headers. Five operations: SendMessage, ReceiveMessages,
 * ReceiveMessageById, AcknowledgeMessage (DELETE lease), ExtendLease (PATCH
 * lease). Wire protocol cross-checked against `@vercel/queue@0.4.0` and the
 * Wave-0 live probes (see processes/Vercel/PROBES.md, probe 4).
 *
 * INTERNAL scaffolding — NOT exported from the Vercel `index.ts`. The public
 * surface is the `SendMessage`/`ReceiveMessages` capabilities.
 *
 * MANUAL-SPEC GAP: this module exists because distilled's Vercel pipeline has
 * no `manual-specs/` convention (unlike aws/cloudflare): `convert.ts` slices
 * ONE OpenAPI document by tag and every generated op is bound to
 * `VercelProtocol` — the management base URL (`creds.apiBaseUrl`) and the
 * management bearer token. The queue data plane needs a per-region host and
 * a per-project OIDC bearer, so a hand-authored model would generate against
 * the wrong host and auth. When the distilled core grows per-service
 * protocol overrides + manual specs for OpenAPI providers, fold this module
 * into `distilled/packages/vercel/manual-specs/queues.json`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Request plumbing
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

/**
 * Data-plane base URL. `VERCEL_QUEUE_BASE_URL` overrides the per-region
 * host — the env contract the official `vercel dev` (and alchemy's local
 * dev broker) uses to redirect queue traffic to a local emulator.
 */
export const queueBaseUrl = (region: string): string => {
  const override = process.env.VERCEL_QUEUE_BASE_URL;
  return override !== undefined && override !== ""
    ? override.replace(/\/$/, "")
    : `https://${region}.vercel-queue.com`;
};

const topicUrl = (
  options: Pick<QueueRequestBase, "region" | "topic">,
  ...segments: string[]
): string =>
  `${queueBaseUrl(options.region)}/api/v3/topic/${[options.topic, ...segments]
    .map((s) => encodeURIComponent(s))
    .join("/")}`;

const withCommonHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  options: QueueRequestBase,
): HttpClientRequest.HttpClientRequest => {
  let req = HttpClientRequest.bearerToken(request, options.token);
  if (options.deploymentId !== undefined) {
    req = HttpClientRequest.setHeader(
      req,
      "Vqs-Deployment-Id",
      options.deploymentId,
    );
  }
  return req;
};

const parseRetryAfterSeconds = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, (dateMs - Date.now()) / 1000);
  return undefined;
};

/**
 * Map a non-2xx response to the shared status errors, for callers that
 * already consumed the body text (a response body can only be read once).
 * Operation-specific statuses (409/410/502/503/404) must be handled BEFORE
 * calling this.
 */
const failCommonWithBody = (
  operation: string,
  options: QueueRequestBase,
  response: HttpClientResponse.HttpClientResponse,
  body: string,
): Effect.Effect<never, QueueCommonError> =>
  Effect.gen(function* () {
    const message = body !== "" ? body : `HTTP ${response.status}`;
    const base = { operation, topic: options.topic };
    switch (response.status) {
      case 400:
        return yield* new QueueBadRequest({ message, ...base });
      case 401:
        return yield* new QueueUnauthorized({ message, ...base });
      case 403:
        return yield* new QueueForbidden({ message, ...base });
      case 429:
        return yield* new QueueRateLimited({
          message,
          ...base,
          retryAfterSeconds: parseRetryAfterSeconds(
            response.headers["retry-after"],
          ),
        });
      default:
        return yield* new QueueInternalError({
          message,
          ...base,
          status: response.status,
        });
    }
  });

/** {@link failCommonWithBody}, reading the body text itself. */
const failCommon = (
  operation: string,
  options: QueueRequestBase,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.flatMap(response.text, (body) =>
    failCommonWithBody(operation, options, response, body),
  );

// ─────────────────────────────────────────────────────────────────────────────
// multipart/mixed parsing (bounded receives — the whole body is buffered)
// ─────────────────────────────────────────────────────────────────────────────

export interface MultipartPart {
  readonly headers: Record<string, string>;
  readonly payload: Uint8Array;
}

const CR = 13;
const LF = 10;
const DASH = 45;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const indexOfBytes = (
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number => {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

/** Extract the boundary parameter from a `multipart/mixed` content type. */
export const parseBoundary = (
  contentType: string | undefined,
): string | undefined => {
  if (contentType === undefined) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
};

/**
 * Parse a buffered `multipart/mixed` body into parts. Header names are
 * lowercased; payload bytes are returned verbatim.
 */
export const parseMultipartMixed = (
  bytes: Uint8Array,
  boundary: string,
): MultipartPart[] => {
  const delimiter = textEncoder.encode(`--${boundary}`);
  const partDelimiter = textEncoder.encode(`\r\n--${boundary}`);
  const headerSeparator = textEncoder.encode("\r\n\r\n");
  const parts: MultipartPart[] = [];

  let index = indexOfBytes(bytes, delimiter, 0);
  while (index !== -1) {
    let cursor = index + delimiter.length;
    // Closing delimiter: `--boundary--`.
    if (bytes[cursor] === DASH && bytes[cursor + 1] === DASH) break;
    // Skip the CRLF terminating the delimiter line.
    if (bytes[cursor] === CR && bytes[cursor + 1] === LF) cursor += 2;
    else if (bytes[cursor] === LF) cursor += 1;

    const nextDelimiter = indexOfBytes(bytes, partDelimiter, cursor);
    const partEnd = nextDelimiter === -1 ? bytes.length : nextDelimiter;

    const separator = indexOfBytes(bytes, headerSeparator, cursor);
    const headers: Record<string, string> = {};
    let payload: Uint8Array;
    if (separator !== -1 && separator < partEnd) {
      const headerText = textDecoder.decode(bytes.subarray(cursor, separator));
      for (const line of headerText.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
      payload = bytes.subarray(separator + headerSeparator.length, partEnd);
    } else {
      payload = bytes.subarray(cursor, partEnd);
    }
    parts.push({ headers, payload });

    if (nextDelimiter === -1) break;
    index = nextDelimiter + 2; // reposition onto `--boundary`
  }
  return parts;
};

/** A received message with its raw (not yet schema-decoded) payload bytes. */
export interface RawQueueMessage extends QueueMessageMeta {
  readonly payload: Uint8Array;
}

/** Parse one multipart part's `Vqs-*` headers; undefined if required ones are missing. */
const toRawMessage = (part: MultipartPart): RawQueueMessage | undefined => {
  const messageId = part.headers["vqs-message-id"];
  const timestamp = part.headers["vqs-timestamp"];
  const receiptHandle = part.headers["vqs-receipt-handle"];
  if (
    messageId === undefined ||
    timestamp === undefined ||
    receiptHandle === undefined
  ) {
    return undefined;
  }
  const deliveryCount = Number.parseInt(
    part.headers["vqs-delivery-count"] ?? "0",
    10,
  );
  if (Number.isNaN(deliveryCount)) return undefined;
  const expiresAt = part.headers["vqs-expires-at"];
  return {
    messageId,
    deliveryCount,
    createdAt: new Date(timestamp),
    expiresAt: expiresAt !== undefined ? new Date(expiresAt) : undefined,
    contentType: part.headers["content-type"] ?? "application/octet-stream",
    receiptHandle,
    payload: part.payload,
  };
};

const readMultipartMessages = (
  operation: string,
  options: QueueRequestBase,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    const boundary = parseBoundary(response.headers["content-type"]);
    if (boundary === undefined) {
      return yield* new QueueMessageCorrupted({
        message: `${operation}: expected a multipart/mixed response, got content-type ${JSON.stringify(
          response.headers["content-type"],
        )}`,
        topic: options.topic,
      });
    }
    const buffer = yield* response.arrayBuffer;
    const parts = yield* Effect.sync(() =>
      parseMultipartMixed(new Uint8Array(buffer), boundary),
    );
    return parts;
  });

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

/** POST /api/v3/topic/{topic} */
export const sendMessageRaw = Effect.fn("Vercel.Queues.sendMessage")(function* (
  options: SendMessageRawOptions,
) {
  const client = yield* HttpClient.HttpClient;
  let request = withCommonHeaders(
    HttpClientRequest.bodyUint8Array(
      HttpClientRequest.post(topicUrl(options)),
      options.body,
      options.contentType,
    ),
    options,
  );
  if (options.idempotencyKey !== undefined) {
    request = HttpClientRequest.setHeader(
      request,
      "Vqs-Idempotency-Key",
      options.idempotencyKey,
    );
  }
  if (options.retentionSeconds !== undefined) {
    request = HttpClientRequest.setHeader(
      request,
      "Vqs-Retention-Seconds",
      String(options.retentionSeconds),
    );
  }
  if (options.delaySeconds !== undefined) {
    request = HttpClientRequest.setHeader(
      request,
      "Vqs-Delay-Seconds",
      String(options.delaySeconds),
    );
  }
  const response = yield* client.execute(request);
  if (response.status === 202) {
    yield* response.text;
    return { messageId: null } as const;
  }
  if (response.status >= 200 && response.status < 300) {
    const json = (yield* response.json) as { messageId?: string } | null;
    return { messageId: json?.messageId ?? null } as const;
  }
  const body = yield* response.text;
  if (response.status === 409) {
    return yield* new DuplicateMessage({
      message: body !== "" ? body : "Duplicate idempotency key detected",
      topic: options.topic,
      idempotencyKey: options.idempotencyKey,
    });
  }
  if (response.status === 502) {
    return yield* new ConsumerDiscoveryFailed({
      message: body !== "" ? body : "Consumer discovery failed",
      topic: options.topic,
      deploymentId: options.deploymentId,
    });
  }
  if (response.status === 503) {
    return yield* new ConsumerRegistryNotConfigured({
      message: body !== "" ? body : "Consumer registry not configured",
      topic: options.topic,
    });
  }
  return yield* failCommonWithBody("send message", options, response, body);
});

export interface ReceiveMessagesRawOptions extends QueueRequestBase {
  readonly consumerGroup: string;
  readonly visibilityTimeoutSeconds?: number | undefined;
  /** 1–10 (`Vqs-Max-Messages`). */
  readonly maxMessages?: number | undefined;
}

/** POST /api/v3/topic/{topic}/consumer/{consumerGroup} */
export const receiveMessagesRaw = Effect.fn("Vercel.Queues.receiveMessages")(
  function* (options: ReceiveMessagesRawOptions) {
    const client = yield* HttpClient.HttpClient;
    let request = withCommonHeaders(
      HttpClientRequest.accept(
        HttpClientRequest.post(
          topicUrl(options, "consumer", options.consumerGroup),
        ),
        "multipart/mixed",
      ),
      options,
    );
    if (options.visibilityTimeoutSeconds !== undefined) {
      request = HttpClientRequest.setHeader(
        request,
        "Vqs-Visibility-Timeout-Seconds",
        String(options.visibilityTimeoutSeconds),
      );
    }
    if (options.maxMessages !== undefined) {
      request = HttpClientRequest.setHeader(
        request,
        "Vqs-Max-Messages",
        String(options.maxMessages),
      );
    }
    const response = yield* client.execute(request);
    if (response.status === 204) {
      yield* response.text;
      return [] as RawQueueMessage[];
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failCommon("receive messages", options, response);
    }
    const parts = yield* readMultipartMessages(
      "receive messages",
      options,
      response,
    );
    // Mirror @vercel/queue: skip parts missing required headers rather than
    // failing the whole batch (they stay leased and expire back).
    return parts.flatMap((part) => {
      const message = toRawMessage(part);
      return message === undefined ? [] : [message];
    });
  },
);

export interface ReceiveMessageByIdRawOptions extends QueueRequestBase {
  readonly consumerGroup: string;
  readonly messageId: string;
  readonly visibilityTimeoutSeconds?: number | undefined;
}

/** POST /api/v3/topic/{topic}/consumer/{consumerGroup}/id/{messageId} */
export const receiveMessageByIdRaw = Effect.fn(
  "Vercel.Queues.receiveMessageById",
)(function* (options: ReceiveMessageByIdRawOptions) {
  const client = yield* HttpClient.HttpClient;
  let request = withCommonHeaders(
    HttpClientRequest.accept(
      HttpClientRequest.post(
        topicUrl(
          options,
          "consumer",
          options.consumerGroup,
          "id",
          options.messageId,
        ),
      ),
      "multipart/mixed",
    ),
    options,
  );
  if (options.visibilityTimeoutSeconds !== undefined) {
    request = HttpClientRequest.setHeader(
      request,
      "Vqs-Visibility-Timeout-Seconds",
      String(options.visibilityTimeoutSeconds),
    );
  }
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text;
    if (response.status === 404) {
      return yield* new MessageNotFound({
        message: body !== "" ? body : `Message ${options.messageId} not found`,
        topic: options.topic,
        id: options.messageId,
      });
    }
    if (response.status === 409) {
      const originalMessageId = yield* Effect.sync(() => {
        try {
          return (JSON.parse(body) as { originalMessageId?: string })
            .originalMessageId;
        } catch {
          // non-JSON 409 body — no original id to surface
          return undefined;
        }
      });
      return yield* new MessageNotAvailable({
        message:
          body !== "" ? body : `Message ${options.messageId} not available`,
        topic: options.topic,
        id: options.messageId,
        originalMessageId,
      });
    }
    if (response.status === 410) {
      return yield* new MessageAlreadyProcessed({
        message:
          body !== ""
            ? body
            : `Message ${options.messageId} was already processed`,
        topic: options.topic,
        id: options.messageId,
      });
    }
    return yield* failCommonWithBody(
      "receive message by id",
      options,
      response,
      body,
    );
  }
  const parts = yield* readMultipartMessages(
    "receive message by id",
    options,
    response,
  );
  for (const part of parts) {
    const message = toRawMessage(part);
    if (message !== undefined) return message;
  }
  return yield* new QueueMessageCorrupted({
    message: `Message ${options.messageId}: response carried no valid message part`,
    topic: options.topic,
    id: options.messageId,
  });
});

export interface LeaseRawOptions extends QueueRequestBase {
  readonly consumerGroup: string;
  readonly receiptHandle: string;
}

const failLease = (
  operation: string,
  options: LeaseRawOptions,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    const body = yield* response.text;
    if (response.status === 404) {
      return yield* new MessageNotFound({
        message: body !== "" ? body : "Unknown receipt handle",
        topic: options.topic,
        id: options.receiptHandle,
      });
    }
    if (response.status === 409) {
      return yield* new MessageNotAvailable({
        message:
          body !== ""
            ? body
            : "Invalid receipt handle, message not in correct state, or already processed",
        topic: options.topic,
        id: options.receiptHandle,
      });
    }
    return yield* failCommonWithBody(operation, options, response, body);
  });

/** DELETE /api/v3/topic/{topic}/consumer/{consumerGroup}/lease/{receiptHandle} */
export const acknowledgeMessageRaw = Effect.fn(
  "Vercel.Queues.acknowledgeMessage",
)(function* (options: LeaseRawOptions) {
  const client = yield* HttpClient.HttpClient;
  const request = withCommonHeaders(
    HttpClientRequest.delete(
      topicUrl(
        options,
        "consumer",
        options.consumerGroup,
        "lease",
        options.receiptHandle,
      ),
    ),
    options,
  );
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* failLease("acknowledge message", options, response);
  }
  yield* response.text;
});

export interface ExtendLeaseRawOptions extends LeaseRawOptions {
  readonly visibilityTimeoutSeconds: number;
}

/** PATCH /api/v3/topic/{topic}/consumer/{consumerGroup}/lease/{receiptHandle} */
export const extendLeaseRaw = Effect.fn("Vercel.Queues.extendLease")(function* (
  options: ExtendLeaseRawOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const request = withCommonHeaders(
    HttpClientRequest.bodyText(
      HttpClientRequest.patch(
        topicUrl(
          options,
          "consumer",
          options.consumerGroup,
          "lease",
          options.receiptHandle,
        ),
      ),
      JSON.stringify({
        visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
      }),
      "application/json",
    ),
    options,
  );
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* failLease("extend lease", options, response);
  }
  yield* response.text;
});
