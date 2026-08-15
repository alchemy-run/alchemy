/**
 * The local (dev-mode) Vercel Queues broker — an in-memory emulation of the
 * queue data plane for `alchemy dev`, mirroring the official CLI's dev
 * broker (`vercel/vercel` `packages/cli/src/util/dev/queue-broker.ts`).
 *
 * Two halves:
 *
 * - **Data-plane HTTP server** (started lazily by {@link serve}, owned by
 *   the sidecar): implements the Queues v3 protocol
 *   (`/api/v3/topic/{topic}[/consumer/{group}[/id/{id} | /lease/{handle}]]`)
 *   so the UNMODIFIED queue clients (`SendMessage`/`ReceiveMessages`, the
 *   consumer bridge's fetch-by-id/ack/extend) work in dev — the
 *   `LocalFunctionProvider` injects `VERCEL_QUEUE_BASE_URL` (and a dev
 *   `VERCEL_QUEUE_TOKEN`) into every dev child, the same contract the
 *   official `vercel dev` uses to redirect `@vercel/queue`.
 * - **Push dispatcher**: a 1s tick loop delivers pending messages to
 *   subscribed Functions by POSTing the platform's CloudEvents v2beta
 *   binary-mode delivery (full-message mode, all `ce-vqs*` headers) to the
 *   Function's {@link LocalFunctionInstance.queueEndpoint}. Consumer groups
 *   derive from the trigger entries each running Function registered in
 *   {@link LocalFunctionState}; handler success acks back through the data
 *   plane (this server), failure leaves the lease to expire and redeliver —
 *   byte-for-byte the deployed contract.
 *
 * Semantics mirrored from the CLI broker: topic wildcards (`*` over
 * `[A-Za-z0-9_-]`), idempotency keys with duplicate markers
 * (receive-by-id on a duplicate id → 409 + `originalMessageId`), delivery
 * counts, visibility timeouts / lease expiry redelivery, `maxDeliveries`
 * drop (32), per-send retention (default 1h) and delay, `retryAfterSeconds`
 * / `initialDelaySeconds` from the trigger.
 *
 * Extended beyond the CLI (platform-faithful, live-verified semantics):
 *
 * - **Dynamic consumer groups** — the platform lets ANY group name receive
 *   (a fresh group replays the topic); the CLI broker only serves
 *   configured groups. Explicit receives here lazily materialize unknown
 *   groups, seeding them with every retained message of the topic.
 * - **Per-deployment partition emulation** — sends record their
 *   `Vqs-Deployment-Id` pin; explicit receives only see messages whose pin
 *   matches theirs, and pinned messages are push-delivered only to the
 *   Function whose current dev deployment id matches (unpinned/`"shared"`
 *   messages deliver to every matching group, keeping cross-function local
 *   queueing possible — declare `partition: "shared"` for that shape, which
 *   is also what the real platform's per-project namespace would require).
 *
 * INTERNAL — NOT exported from the Vercel `index.ts`; lives in the dev
 * sidecar via `localVercelServices` (see `Vercel/LocalRuntime.ts`).
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as crypto from "node:crypto";
import { httpServer } from "../../Util/PlatformServices.ts";
import {
  LocalFunctionState,
  type LocalFunctionInstance,
} from "../LocalRuntime.ts";

/** The bearer value dev children authenticate with (never validated). */
export const DEV_QUEUE_TOKEN = "vc-dev-token";

// Defaults mirrored from the official CLI dev broker.
const DEFAULT_RETRY_AFTER_MS = 60_000;
const DEFAULT_MAX_DELIVERIES = 32;
const DEFAULT_INITIAL_DELAY_MS = 0;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 60_000;
const DEFAULT_RETENTION_MS = 3_600_000;
const TICK_INTERVAL = "1 second";

/**
 * Topic patterns may only contain `[A-Za-z0-9_-]`; `*` expands to zero or
 * more valid topic characters (same rule as the CLI broker).
 */
const topicPatternToRegex = (pattern: string): RegExp => {
  const parts = pattern.split("*").map((s) => s.replaceAll("-", "\\-"));
  return new RegExp(`^${parts.join("[A-Za-z0-9_\\-]*")}$`);
};

interface StoredMessage {
  readonly messageId: string;
  readonly payload: Uint8Array;
  readonly contentType: string;
  readonly queueName: string;
  readonly createdAt: string;
  readonly retentionMs: number;
  /** Epoch ms before which the message is not visible (send delay). */
  readonly availableAt: number;
  /** The sender's `Vqs-Deployment-Id` pin (`undefined` = shared partition). */
  readonly deploymentId: string | undefined;
}

type DeliveryStatus = "pending" | "in-flight" | "acked";

interface DeliveryState {
  status: DeliveryStatus;
  deliveryCount: number;
  receiptHandle: string;
  visibleAt: number;
  leaseExpiresAt: number;
}

/** A consumer group derived from a running Function's trigger entries. */
interface TriggerGroup {
  readonly id: string;
  readonly name: string;
  readonly topicPattern: string;
  readonly topicRegex: RegExp;
  readonly functionId: string;
  readonly retryAfterMs: number;
  readonly initialDelayMs: number;
  readonly maxDeliveries: number;
}

interface IdempotencyRecord {
  readonly messageId: string;
  readonly expiresAt: number;
}

interface DuplicateMessageRecord {
  readonly queueName: string;
  readonly originalMessageId: string;
  readonly expiresAt: number;
}

export interface ReceivedBrokerMessage {
  readonly messageId: string;
  readonly payload: Uint8Array;
  readonly contentType: string;
  readonly deliveryCount: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly receiptHandle: string;
}

/** One CloudEvent push delivery the tick/enqueue decided to perform. */
interface DispatchWork {
  readonly endpoint: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly message: StoredMessage;
  readonly receiptHandle: string;
  readonly deliveryCount: number;
}

const randomId = () => crypto.randomBytes(16).toString("hex");

const expiresAtOf = (message: StoredMessage): string =>
  new Date(
    new Date(message.createdAt).getTime() + message.retentionMs,
  ).toISOString();

/**
 * The pure in-memory broker core. All methods are synchronous state
 * transitions (call them inside `Effect.sync`); push dispatch I/O is
 * returned as {@link DispatchWork} for the effectful shell to perform.
 */
class BrokerCore {
  private readonly messages = new Map<string, StoredMessage>();
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();
  private readonly duplicateMessages = new Map<
    string,
    DuplicateMessageRecord
  >();
  /**
   * Delivery state per group id. Trigger-group ids are
   * `${consumer}::${topicPattern}`; dynamic (explicit-receive) groups use
   * `${consumer}::${topicName}`. Entries persist as `acked` tombstones
   * until the message expires, so lazy dynamic-group seeding never
   * resurrects a completed delivery.
   */
  private readonly deliveryState = new Map<
    string,
    Map<string, DeliveryState>
  >();

  constructor(
    private readonly functions: MutableHashMap.MutableHashMap<
      string,
      LocalFunctionInstance
    >,
  ) {}

  /** Trigger groups derived from the currently registered Functions. */
  private triggerGroups(): TriggerGroup[] {
    const groups = new Map<string, TriggerGroup>();
    for (const fn of MutableHashMap.values(this.functions)) {
      if (fn.queueEndpoint === undefined) continue;
      for (const entry of fn.queues) {
        const id = `${entry.consumer}::${entry.topic}`;
        // First registration wins on a (consumer, topic) collision.
        if (groups.has(id)) continue;
        groups.set(id, {
          id,
          name: entry.consumer,
          topicPattern: entry.topic,
          topicRegex: topicPatternToRegex(entry.topic),
          functionId: fn.functionId,
          retryAfterMs:
            entry.retryAfterSeconds !== undefined
              ? entry.retryAfterSeconds * 1000
              : DEFAULT_RETRY_AFTER_MS,
          initialDelayMs:
            entry.initialDelaySeconds !== undefined
              ? entry.initialDelaySeconds * 1000
              : DEFAULT_INITIAL_DELAY_MS,
          maxDeliveries: DEFAULT_MAX_DELIVERIES,
        });
      }
    }
    return [...groups.values()];
  }

  private groupDeliveries(groupId: string): Map<string, DeliveryState> {
    let deliveries = this.deliveryState.get(groupId);
    if (deliveries === undefined) {
      deliveries = new Map();
      this.deliveryState.set(groupId, deliveries);
    }
    return deliveries;
  }

  enqueue(input: {
    readonly queueName: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
    readonly deploymentId: string | undefined;
    readonly retentionSeconds: number | undefined;
    readonly delaySeconds: number | undefined;
    readonly idempotencyKey: string | undefined;
  }): { readonly messageId: string; readonly dispatches: DispatchWork[] } {
    const now = Date.now();
    const messageId = randomId();
    const retentionMs =
      (input.retentionSeconds ?? 0) > 0
        ? input.retentionSeconds! * 1000
        : DEFAULT_RETENTION_MS;
    const idempotencyRecordKey =
      input.idempotencyKey !== undefined
        ? `${input.queueName}:${input.idempotencyKey}`
        : undefined;

    if (idempotencyRecordKey !== undefined) {
      const record = this.idempotencyRecords.get(idempotencyRecordKey);
      if (record !== undefined && record.expiresAt > now) {
        // Duplicate: return a fresh id that marks the duplicate; receiving
        // it by id reports 409 + originalMessageId (CLI-broker semantics).
        this.duplicateMessages.set(messageId, {
          queueName: input.queueName,
          originalMessageId: record.messageId,
          expiresAt: now + retentionMs,
        });
        return { messageId, dispatches: [] };
      }
      this.idempotencyRecords.set(idempotencyRecordKey, {
        messageId,
        expiresAt: now + retentionMs,
      });
    }

    const delayMs = (input.delaySeconds ?? 0) * 1000;
    const message: StoredMessage = {
      messageId,
      payload: input.payload,
      contentType: input.contentType,
      queueName: input.queueName,
      createdAt: new Date(now).toISOString(),
      retentionMs,
      availableAt: delayMs > 0 ? now + delayMs : 0,
      deploymentId: input.deploymentId,
    };
    this.messages.set(messageId, message);

    const dispatches: DispatchWork[] = [];
    for (const group of this.triggerGroups()) {
      if (!group.topicRegex.test(input.queueName)) continue;
      const deliveries = this.groupDeliveries(group.id);
      const visibleAt = Math.max(
        message.availableAt,
        group.initialDelayMs > 0 ? now + group.initialDelayMs : 0,
      );
      deliveries.set(messageId, {
        status: "pending",
        deliveryCount: 0,
        receiptHandle: "",
        visibleAt,
        leaseExpiresAt: 0,
      });
      if (visibleAt === 0) {
        const work = this.beginDispatch(message, group);
        if (work !== undefined) dispatches.push(work);
      }
    }
    return { messageId, dispatches };
  }

  /**
   * Transition a pending delivery to in-flight and describe the CloudEvent
   * POST to perform — or `undefined` when the group's Function is not
   * currently deliverable (unregistered, no endpoint, or pinned to a
   * different deployment partition), in which case the delivery backs off
   * by the group's retry interval.
   */
  private beginDispatch(
    message: StoredMessage,
    group: TriggerGroup,
  ): DispatchWork | undefined {
    const deliveries = this.deliveryState.get(group.id);
    const state = deliveries?.get(message.messageId);
    if (deliveries === undefined || state === undefined) return undefined;
    if (state.status !== "pending") return undefined;

    if (state.deliveryCount >= group.maxDeliveries) {
      deliveries.delete(message.messageId);
      return undefined;
    }

    const fn = MutableHashMap.get(this.functions, group.functionId);
    const endpoint = fn._tag === "Some" ? fn.value.queueEndpoint : undefined;
    const partitioned =
      message.deploymentId !== undefined &&
      (fn._tag === "None" || fn.value.deploymentId !== message.deploymentId);
    if (endpoint === undefined || partitioned) {
      // Not deliverable right now — back off instead of busy-retrying.
      state.visibleAt = Date.now() + group.retryAfterMs;
      return undefined;
    }

    const receiptHandle = randomId();
    state.status = "in-flight";
    state.receiptHandle = receiptHandle;
    state.deliveryCount++;
    state.leaseExpiresAt = Date.now() + DEFAULT_VISIBILITY_TIMEOUT_MS;
    return {
      endpoint,
      groupId: group.id,
      groupName: group.name,
      message,
      receiptHandle,
      deliveryCount: state.deliveryCount,
    };
  }

  /** A failed (non-2xx / transport-error) push delivery: back to pending. */
  deliveryFailed(groupId: string, messageId: string): void {
    const state = this.deliveryState.get(groupId)?.get(messageId);
    if (state === undefined || state.status !== "in-flight") return;
    const retryAfterMs =
      this.triggerGroups().find((g) => g.id === groupId)?.retryAfterMs ??
      DEFAULT_RETRY_AFTER_MS;
    state.status = "pending";
    state.visibleAt = Date.now() + retryAfterMs;
    state.leaseExpiresAt = 0;
  }

  /**
   * Ensure the (possibly dynamic) receive group exists and is seeded with
   * every retained message of the topic it has not yet tracked — the
   * platform's "a fresh consumer group replays the topic" semantics.
   */
  private seedReceiveGroup(
    queueName: string,
    consumerGroup: string,
  ): Map<string, DeliveryState> {
    // An explicit receive on a topic a trigger group covers shares that
    // group's delivery state (same cursor/leases as the push consumer).
    const trigger = this.triggerGroups().find(
      (g) => g.name === consumerGroup && g.topicRegex.test(queueName),
    );
    const deliveries = this.groupDeliveries(
      trigger?.id ?? `${consumerGroup}::${queueName}`,
    );
    for (const message of this.messages.values()) {
      if (message.queueName !== queueName) continue;
      if (deliveries.has(message.messageId)) continue;
      deliveries.set(message.messageId, {
        status: "pending",
        deliveryCount: 0,
        receiptHandle: "",
        visibleAt: message.availableAt,
        leaseExpiresAt: 0,
      });
    }
    return deliveries;
  }

  receiveMessages(input: {
    readonly queueName: string;
    readonly consumerGroup: string;
    readonly deploymentId: string | undefined;
    readonly limit: number | undefined;
    readonly visibilityTimeoutSeconds: number | undefined;
  }): ReceivedBrokerMessage[] {
    const deliveries = this.seedReceiveGroup(
      input.queueName,
      input.consumerGroup,
    );
    const now = Date.now();
    const limit = Math.min(Math.max(input.limit ?? 1, 1), 10);
    const visibilityTimeoutMs =
      (input.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_MS / 1000) *
      1000;
    const results: ReceivedBrokerMessage[] = [];
    for (const [messageId, state] of deliveries) {
      const message = this.messages.get(messageId);
      if (message === undefined) {
        deliveries.delete(messageId);
        continue;
      }
      if (
        message.queueName !== input.queueName ||
        state.status !== "pending" ||
        state.visibleAt > now ||
        // Partition emulation: a receive only sees its own partition.
        message.deploymentId !== input.deploymentId
      ) {
        continue;
      }
      const receiptHandle = randomId();
      state.status = "in-flight";
      state.receiptHandle = receiptHandle;
      state.deliveryCount++;
      state.leaseExpiresAt = now + visibilityTimeoutMs;
      results.push({
        messageId,
        payload: message.payload,
        contentType: message.contentType,
        deliveryCount: state.deliveryCount,
        createdAt: message.createdAt,
        expiresAt: expiresAtOf(message),
        receiptHandle,
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  receiveById(input: {
    readonly queueName: string;
    readonly consumerGroup: string;
    readonly messageId: string;
    readonly deploymentId: string | undefined;
    readonly visibilityTimeoutSeconds: number | undefined;
  }):
    | { readonly _tag: "NotFound" }
    | { readonly _tag: "Duplicate"; readonly originalMessageId: string }
    | { readonly _tag: "AlreadyProcessed" }
    | { readonly _tag: "Message"; readonly message: ReceivedBrokerMessage } {
    const duplicate = this.duplicateMessages.get(input.messageId);
    if (
      duplicate !== undefined &&
      duplicate.queueName === input.queueName &&
      duplicate.expiresAt > Date.now()
    ) {
      return {
        _tag: "Duplicate",
        originalMessageId: duplicate.originalMessageId,
      };
    }
    const message = this.messages.get(input.messageId);
    if (
      message === undefined ||
      message.queueName !== input.queueName ||
      message.deploymentId !== input.deploymentId
    ) {
      return { _tag: "NotFound" };
    }
    const deliveries = this.seedReceiveGroup(
      input.queueName,
      input.consumerGroup,
    );
    const state = deliveries.get(input.messageId);
    if (state === undefined) return { _tag: "NotFound" };
    if (state.status === "acked") return { _tag: "AlreadyProcessed" };
    if (state.status === "pending") {
      // Lease it, exactly like a batch receive would.
      state.status = "in-flight";
      state.receiptHandle = randomId();
      state.deliveryCount++;
      state.leaseExpiresAt =
        Date.now() +
        (input.visibilityTimeoutSeconds !== undefined
          ? input.visibilityTimeoutSeconds * 1000
          : DEFAULT_VISIBILITY_TIMEOUT_MS);
    }
    return {
      _tag: "Message",
      message: {
        messageId: message.messageId,
        payload: message.payload,
        contentType: message.contentType,
        deliveryCount: state.deliveryCount,
        createdAt: message.createdAt,
        expiresAt: expiresAtOf(message),
        receiptHandle: state.receiptHandle,
      },
    };
  }

  private findByReceiptHandle(
    consumerGroup: string,
    receiptHandle: string,
  ): { deliveries: Map<string, DeliveryState>; messageId: string } | undefined {
    for (const [groupId, deliveries] of this.deliveryState) {
      if (!groupId.startsWith(`${consumerGroup}::`)) continue;
      for (const [messageId, state] of deliveries) {
        if (
          state.receiptHandle === receiptHandle &&
          state.status === "in-flight"
        ) {
          return { deliveries, messageId };
        }
      }
    }
    return undefined;
  }

  /** Complete a lease. `false` = unknown/expired receipt handle. */
  acknowledge(consumerGroup: string, receiptHandle: string): boolean {
    const found = this.findByReceiptHandle(consumerGroup, receiptHandle);
    if (found === undefined) return false;
    const state = found.deliveries.get(found.messageId)!;
    state.status = "acked";
    state.leaseExpiresAt = 0;
    return true;
  }

  /** Extend (or shrink) an in-flight lease. `false` = unknown handle. */
  extendLease(
    consumerGroup: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): boolean {
    const found = this.findByReceiptHandle(consumerGroup, receiptHandle);
    if (found === undefined) return false;
    const state = found.deliveries.get(found.messageId)!;
    state.leaseExpiresAt = Date.now() + visibilityTimeoutSeconds * 1000;
    return true;
  }

  /**
   * One broker tick: expire records and messages, return expired leases to
   * pending (or drop at maxDeliveries), and collect the push dispatches
   * now due.
   */
  tick(): DispatchWork[] {
    const now = Date.now();
    for (const [key, record] of this.idempotencyRecords) {
      if (record.expiresAt <= now) this.idempotencyRecords.delete(key);
    }
    for (const [messageId, record] of this.duplicateMessages) {
      if (record.expiresAt <= now) this.duplicateMessages.delete(messageId);
    }
    for (const [messageId, message] of this.messages) {
      if (new Date(message.createdAt).getTime() + message.retentionMs <= now) {
        this.messages.delete(messageId);
        for (const deliveries of this.deliveryState.values()) {
          deliveries.delete(messageId);
        }
      }
    }

    const dispatches: DispatchWork[] = [];
    const groups = this.triggerGroups();
    for (const group of groups) {
      const deliveries = this.deliveryState.get(group.id);
      if (deliveries === undefined) continue;
      for (const [messageId, state] of deliveries) {
        const message = this.messages.get(messageId);
        if (message === undefined) {
          deliveries.delete(messageId);
          continue;
        }
        if (state.status === "in-flight" && state.leaseExpiresAt < now) {
          if (state.deliveryCount >= group.maxDeliveries) {
            deliveries.delete(messageId);
            continue;
          }
          state.status = "pending";
          state.visibleAt = now + group.retryAfterMs;
          state.leaseExpiresAt = 0;
          continue;
        }
        if (state.status === "pending" && state.visibleAt <= now) {
          const work = this.beginDispatch(message, group);
          if (work !== undefined) dispatches.push(work);
        }
      }
    }
    return dispatches;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP data plane + push dispatch (the effectful shell)
// ─────────────────────────────────────────────────────────────────────────────

const TOPIC_PATH = /^\/api\/v3\/topic\/([A-Za-z0-9_-]+)(?:\/(.*))?$/;
const CONSUMER_PATH = /^consumer\/([A-Za-z0-9_-]+)(?:\/(.*))?$/;

const intHeader = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const multipartResponse = (
  messages: ReadonlyArray<ReceivedBrokerMessage>,
): HttpServerResponse.HttpServerResponse => {
  const boundary = `----alchemydevboundary${randomId()}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const message of messages) {
    const headers = [
      `Vqs-Message-Id: ${message.messageId}`,
      `Vqs-Delivery-Count: ${message.deliveryCount}`,
      `Vqs-Timestamp: ${message.createdAt}`,
      `Vqs-Expires-At: ${message.expiresAt}`,
      `Vqs-Receipt-Handle: ${message.receiptHandle}`,
      `Content-Type: ${message.contentType}`,
    ].join("\r\n");
    parts.push(
      encoder.encode(`--${boundary}\r\n${headers}\r\n\r\n`),
      message.payload,
      encoder.encode("\r\n"),
    );
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  const size = parts.reduce((n, part) => n + part.length, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return HttpServerResponse.uint8Array(body, {
    status: 200,
    contentType: `multipart/mixed; boundary=${boundary}`,
  });
};

/** POST one CloudEvents v2beta binary-mode delivery (full-message mode). */
const dispatchOne = (
  client: HttpClient.HttpClient,
  core: BrokerCore,
  work: DispatchWork,
) =>
  client
    .execute(
      HttpClientRequest.post(work.endpoint).pipe(
        HttpClientRequest.setHeaders({
          "content-type": work.message.contentType,
          "ce-type": "com.vercel.queue.v2beta",
          "ce-specversion": "1.0",
          "ce-source": `/topic/${work.message.queueName}/consumer/${work.groupName}`,
          "ce-id": work.message.messageId,
          "ce-time": new Date().toISOString(),
          "ce-vqsmessageid": work.message.messageId,
          "ce-vqsqueuename": work.message.queueName,
          "ce-vqsconsumergroup": work.groupName,
          "ce-vqsreceipthandle": work.receiptHandle,
          "ce-vqsdeliverycount": String(work.deliveryCount),
          "ce-vqscreatedat": work.message.createdAt,
          "ce-vqsexpiresat": expiresAtOf(work.message),
          "ce-vqsregion": "dev1",
        }),
        HttpClientRequest.bodyUint8Array(
          work.message.payload,
          work.message.contentType,
        ),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.asVoid(response.text)
          : Effect.andThen(
              response.text,
              Effect.sync(() =>
                core.deliveryFailed(work.groupId, work.message.messageId),
              ),
            ),
      ),
      Effect.catchCause((cause) =>
        Effect.andThen(
          Effect.logDebug(
            `[vercel dev queues] delivery of ${work.message.messageId} to '${work.groupName}' failed`,
            cause,
          ),
          Effect.sync(() =>
            core.deliveryFailed(work.groupId, work.message.messageId),
          ),
        ),
      ),
    );

const makeHandler = (
  core: BrokerCore,
  /** Run a push dispatch OUTSIDE the request fiber (its scope outlives it). */
  dispatchInBackground: (work: DispatchWork) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = request.url.split("?")[0];
    const topicMatch = TOPIC_PATH.exec(pathname);
    if (topicMatch === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const [, queueName, rest = ""] = topicMatch;
    const deploymentId = request.headers["vqs-deployment-id"];

    // POST /api/v3/topic/{topic} — send.
    if (rest === "" && request.method === "POST") {
      const payload = new Uint8Array(yield* request.arrayBuffer);
      const { messageId, dispatches } = yield* Effect.sync(() =>
        core.enqueue({
          queueName,
          payload,
          contentType:
            request.headers["content-type"] ?? "application/octet-stream",
          deploymentId,
          retentionSeconds: intHeader(request.headers["vqs-retention-seconds"]),
          delaySeconds: intHeader(request.headers["vqs-delay-seconds"]),
          idempotencyKey: request.headers["vqs-idempotency-key"],
        }),
      );
      // No-delay deliveries dispatch immediately, off the request fiber.
      for (const work of dispatches) {
        yield* dispatchInBackground(work);
      }
      return yield* HttpServerResponse.json(
        { messageId },
        { status: 201, headers: { "vqs-message-id": messageId } },
      );
    }

    const consumerMatch = CONSUMER_PATH.exec(rest);
    if (consumerMatch === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const [, consumerGroup, action = ""] = consumerMatch;

    // POST .../consumer/{group} — batch receive.
    if (action === "" && request.method === "POST") {
      const messages = yield* Effect.sync(() =>
        core.receiveMessages({
          queueName,
          consumerGroup,
          deploymentId,
          limit: intHeader(request.headers["vqs-max-messages"]),
          visibilityTimeoutSeconds: intHeader(
            request.headers["vqs-visibility-timeout-seconds"],
          ),
        }),
      );
      return messages.length === 0
        ? HttpServerResponse.empty({ status: 204 })
        : multipartResponse(messages);
    }

    // POST .../consumer/{group}/id/{messageId} — receive by id.
    const idMatch = /^id\/([^/]+)$/.exec(action);
    if (idMatch !== null && request.method === "POST") {
      const result = yield* Effect.sync(() =>
        core.receiveById({
          queueName,
          consumerGroup,
          messageId: decodeURIComponent(idMatch[1]),
          deploymentId,
          visibilityTimeoutSeconds: intHeader(
            request.headers["vqs-visibility-timeout-seconds"],
          ),
        }),
      );
      switch (result._tag) {
        case "Duplicate":
          return yield* HttpServerResponse.json(
            {
              error:
                "This messageId was a duplicate - use originalMessageId instead",
              originalMessageId: result.originalMessageId,
            },
            { status: 409 },
          );
        case "NotFound":
          return HttpServerResponse.text("Message not found", { status: 404 });
        case "AlreadyProcessed":
          return HttpServerResponse.text("Message already processed", {
            status: 410,
          });
        case "Message":
          return multipartResponse([result.message]);
      }
    }

    // DELETE/PATCH .../consumer/{group}/lease/{receiptHandle}[/visibility]
    const leaseMatch = /^lease\/([^/]+)(?:\/visibility)?$/.exec(action);
    if (leaseMatch !== null) {
      const receiptHandle = decodeURIComponent(leaseMatch[1]);
      if (request.method === "DELETE") {
        const acked = yield* Effect.sync(() =>
          core.acknowledge(consumerGroup, receiptHandle),
        );
        return acked
          ? HttpServerResponse.empty({ status: 204 })
          : yield* HttpServerResponse.json(
              { error: "Message not found" },
              { status: 404 },
            );
      }
      if (request.method === "PATCH") {
        const body = yield* request.arrayBuffer;
        const timeoutSeconds = yield* Effect.sync(() => {
          try {
            const parsed = JSON.parse(new TextDecoder().decode(body)) as {
              visibilityTimeoutSeconds?: unknown;
            };
            return typeof parsed.visibilityTimeoutSeconds === "number" &&
              parsed.visibilityTimeoutSeconds >= 0
              ? parsed.visibilityTimeoutSeconds
              : DEFAULT_VISIBILITY_TIMEOUT_MS / 1000;
          } catch {
            return DEFAULT_VISIBILITY_TIMEOUT_MS / 1000;
          }
        });
        const extended = yield* Effect.sync(() =>
          core.extendLease(consumerGroup, receiptHandle, timeoutSeconds),
        );
        return extended
          ? yield* HttpServerResponse.json({ success: true })
          : yield* HttpServerResponse.json(
              { error: "Message not found" },
              { status: 404 },
            );
      }
    }

    return HttpServerResponse.text("Not Found", { status: 404 });
  });

/**
 * The dev-sidecar queue broker service. `serve` starts the data-plane HTTP
 * server and the dispatch tick loop ONCE in the caller's `Scope` (later
 * callers get the memoized base URL), returning the base URL to inject as
 * `VERCEL_QUEUE_BASE_URL`.
 */
export class LocalQueueBroker extends Context.Service<
  LocalQueueBroker,
  {
    readonly serve: Effect.Effect<
      string,
      never,
      Scope.Scope | HttpClient.HttpClient
    >;
  }
>()("alchemy/vercel/LocalQueueBroker") {}

export const LocalQueueBrokerLive: Layer.Layer<
  LocalQueueBroker,
  never,
  LocalFunctionState
> = Layer.effect(
  LocalQueueBroker,
  Effect.gen(function* () {
    const { functions } = yield* LocalFunctionState;
    const core = new BrokerCore(functions);
    const started = yield* Deferred.make<string>();
    let starting = false;

    const start = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const scope = yield* Effect.scope;
      const dispatchInBackground = (work: DispatchWork) =>
        Effect.asVoid(Effect.forkIn(dispatchOne(client, core, work), scope));
      const context = yield* Layer.build(httpServer(0, "127.0.0.1"));
      const server = Context.get(context, HttpServer.HttpServer);
      yield* server.serve(makeHandler(core, dispatchInBackground));
      const url = HttpServer.formatAddress(server.address)
        .replace("127.0.0.1", "localhost")
        .replace(/\/$/, "");
      // The 1s broker tick: expiry, lease returns, pending dispatch.
      yield* Effect.sync(() => core.tick()).pipe(
        Effect.flatMap((work) =>
          Effect.forEach(work, (item) => dispatchOne(client, core, item), {
            discard: true,
          }),
        ),
        Effect.andThen(Effect.sleep(TICK_INTERVAL)),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Deferred.succeed(started, url);
    });

    return LocalQueueBroker.of({
      serve: Effect.suspend(() => {
        if (!starting) {
          starting = true;
          // A failure to bind an ephemeral loopback port is an environment
          // defect, not a typed lifecycle error.
          return Effect.andThen(Effect.orDie(start), Deferred.await(started));
        }
        return Deferred.await(started);
      }),
    });
  }),
);
