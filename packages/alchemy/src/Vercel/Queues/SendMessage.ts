import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { ambientOidcTokenUnsafe } from "./OidcToken.ts";
import { sendMessageRaw } from "./QueueApi.ts";
import {
  resolveQueueDeploymentId,
  resolveQueueToken,
  type QueueClientOptions,
} from "./QueueClient.ts";
import type { SendMessageError, SendReceipt } from "./QueueTypes.ts";
import type { Topic } from "./Topic.ts";

const textEncoder = new TextEncoder();

/** Per-send overrides of the topic's send defaults. */
export interface SendOptions {
  /**
   * Idempotency key (`Vqs-Idempotency-Key`) — a duplicate key fails with the
   * typed `DuplicateMessage` error.
   */
  readonly idempotencyKey?: string;
  /** Delivery delay in seconds; defaults to the topic's `delaySeconds`. */
  readonly delaySeconds?: number;
  /** Retention in seconds; defaults to the topic's `retentionSeconds`. */
  readonly retentionSeconds?: number;
}

/**
 * Typed producer client for a {@link Topic}. Messages are encoded with the
 * topic's schema and sent as JSON to the topic's region endpoint, pinned to
 * the resolved deployment partition.
 */
export interface SendMessageClient<
  S extends Schema.Top = Schema.Top,
  R = never,
> {
  readonly topic: Topic<S>;
  readonly send: (
    message: S["Type"],
    options?: SendOptions,
  ) => Effect.Effect<
    SendReceipt,
    SendMessageError | Schema.SchemaError,
    R | S["EncodingServices"]
  >;
}

/**
 * Send typed messages to a Vercel queue {@link Topic}.
 *
 * The init (bind) half registers the topic's env refs on the host Function
 * (region, topic name, partition mode — never tokens: the runtime OIDC token
 * is ambient inside a deployed Function); the runtime client schema-encodes
 * each message and pins `Vqs-Deployment-Id` from `VERCEL_DEPLOYMENT_ID`
 * unless the topic is declared `partition: "shared"`. Provide the
 * implementation with `Effect.provide(Vercel.SendMessageHttp)`.
 *
 * @binding
 * @section Sending Messages
 * @example Producer inside an Effect-native Function
 * ```typescript
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const orders = yield* Vercel.SendMessage(Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders
 *           .send({ orderId: crypto.randomUUID(), amountCents: 4200 })
 *           .pipe(Effect.orDie);
 *         return yield* HttpServerResponse.json({ queued: true });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Vercel.SendMessageHttp)),
 * ) {}
 * ```
 *
 * @example Sending from outside Vercel (tests, scripts)
 * ```typescript
 * const token = yield* Vercel.mintProjectOidcToken(fn.projectId);
 * const orders = yield* Vercel.makeSendMessageClient(Orders, {
 *   token,
 *   deploymentId: fn.deploymentId,
 * });
 * yield* orders.send({ orderId: "o-1", amountCents: 100 });
 * ```
 */
export interface SendMessage extends Binding.Service<
  SendMessage,
  "Vercel.SendMessage",
  (
    topic: Topic<Schema.Top>,
  ) => Effect.Effect<SendMessageClient<Schema.Top, RuntimeContext>>
> {
  <S extends Schema.Top>(
    topic: Topic<S>,
  ): Effect.Effect<SendMessageClient<S, RuntimeContext>, never, SendMessage>;
}

export const SendMessage = Binding.Service<SendMessage>("Vercel.SendMessage");

/**
 * Build a {@link SendMessageClient} directly — the constructor for code
 * running OUTSIDE a deployed Function (tests, scripts, other clouds'
 * runtimes), where the OIDC token is minted rather than ambient.
 *
 * The `HttpClient` is captured once at construction; the returned client's
 * `send` needs no further context (beyond the schema's own services).
 */
export const makeSendMessageClient = <S extends Schema.Top>(
  topic: Topic<S>,
  options?: QueueClientOptions,
): Effect.Effect<SendMessageClient<S>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    const encode = Schema.encodeEffect(topic.schema);
    const send: SendMessageClient<S>["send"] = Effect.fn(
      `Vercel.SendMessage(${topic.topicName})`,
    )(function* (message: S["Type"], sendOptions?: SendOptions) {
      const token = yield* resolveQueueToken(options?.token);
      const deploymentId = yield* resolveQueueDeploymentId(
        topic,
        options?.deploymentId,
      );
      const encoded = yield* encode(message);
      const body = yield* Effect.sync(() =>
        textEncoder.encode(JSON.stringify(encoded)),
      );
      return yield* sendMessageRaw({
        region: topic.region,
        topic: topic.topicName,
        token,
        deploymentId,
        body,
        contentType: "application/json",
        idempotencyKey: sendOptions?.idempotencyKey,
        retentionSeconds:
          sendOptions?.retentionSeconds ?? topic.retentionSeconds,
        delaySeconds: sendOptions?.delaySeconds ?? topic.delaySeconds,
      }).pipe(Effect.provideContext(context));
    }) as SendMessageClient<S>["send"];
    return { topic, send } satisfies SendMessageClient<S>;
  });

// ─────────────────────────────────────────────────────────────────────────────
// Async mode (no Effect runtime)
// ─────────────────────────────────────────────────────────────────────────────

/** Promise-based producer for plain async Functions. */
export interface AsyncSendMessageClient<S extends Schema.Top = Schema.Top> {
  readonly topic: Topic<S>;
  send(message: S["Type"], options?: SendOptions): Promise<SendReceipt>;
}

/**
 * `fromEnv`-style constructor for **plain async Functions** (no Effect
 * runtime shipped): resolves the ambient OIDC token and deployment id from
 * the environment at call time, encodes with the topic's schema, and throws
 * plain `Error`s. For Effect code use {@link SendMessage} (bound) or
 * {@link makeSendMessageClient}.
 *
 * @example Async handler
 * ```typescript
 * import { Orders } from "../resources.ts";
 * const orders = Vercel.sendMessageFromEnv(Orders);
 *
 * export default {
 *   async fetch(request: Request): Promise<Response> {
 *     await orders.send({ orderId: crypto.randomUUID(), amountCents: 4200 });
 *     return Response.json({ queued: true });
 *   },
 * };
 * ```
 */
export const sendMessageFromEnv = <
  // Sync encoding cannot provide services — constrain to service-free
  // schemas (`EncodingServices: never`), which every plain data schema is.
  S extends Schema.Top & { readonly EncodingServices: never },
>(
  topic: Topic<S>,
  options?: {
    /** Explicit OIDC bearer token; defaults to the ambient token. */
    readonly token?: string;
    /** Explicit deployment pin; `null` opts out of pinning. */
    readonly deploymentId?: string | null;
  },
): AsyncSendMessageClient<S> => {
  const encodeSync = Schema.encodeSync(topic.schema);
  return {
    topic,
    async send(message, sendOptions) {
      const token = options?.token ?? ambientOidcTokenUnsafe();
      if (token === undefined || token === "") {
        throw new Error(
          `Vercel.sendMessageFromEnv(${topic.topicName}): no ambient OIDC token (x-vercel-oidc-token / VERCEL_OIDC_TOKEN)`,
        );
      }
      let deploymentId: string | undefined;
      if (options?.deploymentId === null || topic.partition === "shared") {
        deploymentId = undefined;
      } else {
        deploymentId =
          options?.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID;
        if (deploymentId === undefined || deploymentId === "") {
          throw new Error(
            `Vercel.sendMessageFromEnv(${topic.topicName}): topic partitions by deployment but VERCEL_DEPLOYMENT_ID is not set`,
          );
        }
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      if (deploymentId !== undefined) {
        headers["Vqs-Deployment-Id"] = deploymentId;
      }
      if (sendOptions?.idempotencyKey !== undefined) {
        headers["Vqs-Idempotency-Key"] = sendOptions.idempotencyKey;
      }
      const retentionSeconds =
        sendOptions?.retentionSeconds ?? topic.retentionSeconds;
      if (retentionSeconds !== undefined) {
        headers["Vqs-Retention-Seconds"] = String(retentionSeconds);
      }
      const delaySeconds = sendOptions?.delaySeconds ?? topic.delaySeconds;
      if (delaySeconds !== undefined) {
        headers["Vqs-Delay-Seconds"] = String(delaySeconds);
      }
      const response = await fetch(
        `https://${topic.region}.vercel-queue.com/api/v3/topic/${encodeURIComponent(topic.topicName)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(encodeSync(message)),
        },
      );
      if (response.status === 202) {
        await response.text();
        return { messageId: null };
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Vercel.sendMessageFromEnv(${topic.topicName}): send failed with ${response.status} ${response.statusText}: ${body}`,
        );
      }
      const json = (await response.json()) as { messageId?: string } | null;
      return { messageId: json?.messageId ?? null };
    },
  };
};
