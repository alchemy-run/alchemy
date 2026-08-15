import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  acknowledgeMessageRaw,
  receiveMessageByIdRaw,
  type RawQueueMessage,
} from "./QueueData.ts";
import { resolveQueueDeploymentId, resolveQueueToken } from "./QueueClient.ts";
import { QueueMessageCorrupted, type QueueDeliveryMeta } from "./QueueTypes.ts";
import type { Topic } from "./Topic.ts";

/**
 * Push-delivery (CloudEvent callback) runtime for the `subscribe` event
 * source: parses the platform's queue-trigger POST, decodes the payload with
 * the topic's schema, runs the registered handler, and completes the lease.
 *
 * Wire contract (cross-checked against `@vercel/queue`'s `parseCallback` and
 * the Wave-0 trigger probes): a `queue/v2beta` trigger delivers messages as
 * an HTTP POST in CloudEvents *binary* mode — metadata in `ce-*` headers,
 * payload in the body:
 *
 * - `ce-type: com.vercel.queue.v2beta` (anything else is a 400)
 * - `ce-vqsqueuename` / `ce-vqsconsumergroup` / `ce-vqsmessageid` (required)
 * - `ce-vqsreceipthandle` present ⇒ **full-message mode**: the body IS the
 *   payload, plus `ce-vqsdeliverycount` / `ce-vqscreatedat` /
 *   `ce-vqsexpiresat` / `content-type`
 * - `ce-vqsreceipthandle` absent ⇒ **routing-only mode** (large payloads):
 *   the consumer fetches the message by id from the data plane, which also
 *   leases it
 *
 * Completion semantics mirror `@vercel/queue`: handler success ⇒ explicit
 * data-plane ack (idempotent — an already-completed lease is tolerated) and
 * a 200; handler failure ⇒ NO ack and a 500, so the message becomes visible
 * again after the trigger's visibility timeout and is redelivered
 * (at-least-once).
 *
 * INTERNAL scaffolding — NOT exported from the Vercel `index.ts`. The public
 * surface is the `subscribe` event source.
 */

/** The CloudEvent type a `queue/v2beta` trigger delivers. */
const CLOUD_EVENT_TYPE_V2BETA = "com.vercel.queue.v2beta";

/** A registered push subscription (one per topic per Function). */
export interface QueueSubscriptionEntry {
  readonly topic: Topic;
  readonly consumerGroup: string;
  readonly handler: (
    payload: any,
    meta: QueueDeliveryMeta,
  ) => Effect.Effect<void, unknown, any>;
}

interface ParsedDelivery {
  readonly queueName: string;
  readonly consumerGroup: string;
  readonly messageId: string;
  readonly region: string | undefined;
  readonly receiptHandle: string | undefined;
  readonly deliveryCount: number | undefined;
  readonly createdAt: string | undefined;
  readonly expiresAt: string | undefined;
  readonly contentType: string | undefined;
}

/** Parse the CloudEvents binary-mode delivery headers (v2beta only). */
const parseDeliveryHeaders = (
  headers: Headers,
): ParsedDelivery | { readonly parseError: string } => {
  const ceType = headers.get("ce-type");
  if (ceType !== CLOUD_EVENT_TYPE_V2BETA) {
    return {
      parseError: `expected CloudEvent type '${CLOUD_EVENT_TYPE_V2BETA}', got '${String(ceType)}'`,
    };
  }
  const queueName = headers.get("ce-vqsqueuename");
  const consumerGroup = headers.get("ce-vqsconsumergroup");
  const messageId = headers.get("ce-vqsmessageid");
  if (queueName === null || consumerGroup === null || messageId === null) {
    return {
      parseError:
        "missing required CloudEvent headers (ce-vqsqueuename / ce-vqsconsumergroup / ce-vqsmessageid)",
    };
  }
  const deliveryCountRaw = headers.get("ce-vqsdeliverycount");
  const deliveryCount =
    deliveryCountRaw !== null
      ? Number.parseInt(deliveryCountRaw, 10)
      : Number.NaN;
  return {
    queueName,
    consumerGroup,
    messageId,
    region: headers.get("ce-vqsregion") ?? undefined,
    receiptHandle: headers.get("ce-vqsreceipthandle") ?? undefined,
    deliveryCount: Number.isNaN(deliveryCount) ? undefined : deliveryCount,
    createdAt: headers.get("ce-vqscreatedat") ?? undefined,
    expiresAt: headers.get("ce-vqsexpiresat") ?? undefined,
    contentType: headers.get("content-type") ?? undefined,
  };
};

const textDecoder = new TextDecoder();

/** Decode a raw message's JSON payload with the subscription topic's schema. */
const decodePayload = (topic: Topic, raw: RawQueueMessage) =>
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
    return yield* Schema.decodeUnknownEffect(topic.schema)(json);
  });

const processDelivery = (
  entry: QueueSubscriptionEntry,
  parsed: ParsedDelivery,
  bodyBytes: Uint8Array | undefined,
): Effect.Effect<Response, unknown, any> =>
  Effect.gen(function* () {
    const topic = entry.topic;
    // Ambient identity: the OIDC token the platform provisions and the
    // deployment pin — receives/acks are partitioned by `Vqs-Deployment-Id`
    // exactly like sends (live-verified).
    const token = yield* resolveQueueToken(undefined);
    const deploymentId = yield* resolveQueueDeploymentId(topic, undefined);
    const common = {
      // The delivery names its region; fall back to the topic's pin.
      region: parsed.region ?? topic.region,
      topic: topic.topicName,
      token,
      deploymentId,
      // Lease operations are scoped to the DELIVERY's consumer group.
      consumerGroup: parsed.consumerGroup,
    };

    let raw: RawQueueMessage;
    if (parsed.receiptHandle !== undefined && bodyBytes !== undefined) {
      // Full-message mode: the POST body is the payload.
      raw = {
        messageId: parsed.messageId,
        deliveryCount: parsed.deliveryCount ?? 1,
        createdAt:
          parsed.createdAt !== undefined
            ? new Date(parsed.createdAt)
            : new Date(),
        expiresAt:
          parsed.expiresAt !== undefined
            ? new Date(parsed.expiresAt)
            : undefined,
        contentType: parsed.contentType ?? "application/json",
        receiptHandle: parsed.receiptHandle,
        payload: bodyBytes,
      };
    } else {
      // Routing-only mode: fetch (and thereby lease) the message by id.
      const fetched = yield* receiveMessageByIdRaw({
        ...common,
        messageId: parsed.messageId,
      }).pipe(
        Effect.catchTag(
          [
            "Vercel.Queues.MessageAlreadyProcessed",
            "Vercel.Queues.MessageNotFound",
          ],
          (error) =>
            // Already completed by an earlier delivery, or expired — nothing
            // left to process; report success so the platform stops retrying.
            Effect.logDebug(
              `Vercel queue delivery for message ${parsed.messageId} is already settled (${error._tag})`,
            ).pipe(Effect.as(undefined)),
        ),
      );
      if (fetched === undefined) {
        return Response.json({ status: "already-processed" });
      }
      raw = fetched;
    }

    const payload = yield* decodePayload(topic, raw);
    const meta: QueueDeliveryMeta = {
      messageId: raw.messageId,
      deliveryCount: raw.deliveryCount,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      contentType: raw.contentType,
      receiptHandle: raw.receiptHandle,
      topicName: parsed.queueName,
      consumerGroup: parsed.consumerGroup,
    };
    yield* entry.handler(payload, meta);

    // Handler succeeded — complete the lease. A lease already completed
    // elsewhere (races, platform-side ack on 200) is success, not failure.
    yield* acknowledgeMessageRaw({
      ...common,
      receiptHandle: raw.receiptHandle,
    }).pipe(
      Effect.catchTag(
        ["Vercel.Queues.MessageNotFound", "Vercel.Queues.MessageNotAvailable"],
        () => Effect.void,
      ),
    );
    return Response.json({ status: "success" });
  });

/**
 * Handle one queue-trigger POST against the Function's subscription
 * registry. Never fails: every outcome is a Response — 200 on success (or
 * an already-settled delivery), 400 on a malformed CloudEvent, 404 for a
 * topic with no registered subscription, 500 on handler/decoding failure
 * (NO ack ⇒ the platform redelivers after the visibility timeout).
 */
export const runQueueCallback = (
  registry: ReadonlyMap<string, QueueSubscriptionEntry>,
  webRequest: Request,
): Effect.Effect<Response, never, any> =>
  Effect.gen(function* () {
    if (webRequest.method !== "POST") {
      return Response.json({ ok: true });
    }
    const parsed = parseDeliveryHeaders(webRequest.headers);
    if ("parseError" in parsed) {
      return Response.json({ error: parsed.parseError }, { status: 400 });
    }
    const entry = registry.get(parsed.queueName);
    if (entry === undefined) {
      yield* Effect.logWarning(
        `Vercel queue delivery for topic '${parsed.queueName}' has no registered subscription`,
      );
      return Response.json(
        { error: `no subscription for topic '${parsed.queueName}'` },
        { status: 404 },
      );
    }
    const bodyBytes =
      parsed.receiptHandle !== undefined
        ? new Uint8Array(yield* Effect.promise(() => webRequest.arrayBuffer()))
        : undefined;
    return yield* processDelivery(entry, parsed, bodyBytes).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          `Vercel queue delivery failed (topic '${parsed.queueName}', message ${parsed.messageId})`,
          cause,
        ).pipe(
          Effect.as(
            Response.json({ error: "queue delivery failed" }, { status: 500 }),
          ),
        ),
      ),
    );
  });
