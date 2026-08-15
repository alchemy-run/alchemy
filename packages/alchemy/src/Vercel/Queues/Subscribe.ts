import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as Namespace from "../../Namespace.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { VercelFunctionContext } from "../Functions/FunctionBridge.ts";
import { Function } from "../Functions/Function.ts";
import type { QueueDeliveryMeta } from "./QueueTypes.ts";
import type { Topic } from "./Topic.ts";

/** Consumer-group names on the platform: keep to a safe charset. */
const sanitizeConsumerGroup = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_-]/g, "-");

export interface SubscribeOptions {
  /**
   * Consumer group the platform consumes under. Groups have independent
   * cursors/acks, so keep it stable across deploys — a fresh group replays
   * the topic from the beginning.
   * @default "alchemy-{FunctionLogicalId}"
   */
  readonly consumerGroup?: string;
  /** Redelivery backoff after a failed delivery, in seconds. */
  readonly retryAfterSeconds?: number;
  /** Delay before the first delivery attempt, in seconds. */
  readonly initialDelaySeconds?: number;
}

/**
 * Subscribe a Vercel Function to a queue {@link Topic} with an Effect
 * handler — Vercel's push-based queue consumption.
 *
 * A single call wires both halves of the event source:
 *
 * - **Deploy-time**: contributes a `queue/v2beta` trigger through the
 *   Function's binding contract. Because a function carrying a queue trigger
 *   loses ALL public HTTP routing (live-verified, D9a), the provider lowers
 *   the trigger into a SEPARATE consumer function
 *   (`functions/_alchemy-queue.func`) that shares the Function's module —
 *   the public function keeps serving HTTP, and the consumer function is
 *   never publicly routed.
 * - **Runtime**: registers the handler in the Function's subscription
 *   registry; the consumer bridge decodes each platform delivery with the
 *   topic's schema, runs the handler, and completes the lease. A failing
 *   handler responds 500 without acking, so the message is redelivered after
 *   the trigger's visibility window (at-least-once — make handlers
 *   idempotent).
 *
 * Sends into the topic must be deployment-pinned (the default `partition:
 * "deployment"`): the platform's push delivery only consumes the sending
 * deployment's partition (live-verified).
 *
 * Requires `QueueEventSourceLive` provided on the Function's init Effect.
 *
 * @binding
 * @product Queues
 *
 * @section Subscribing to a Topic
 * @example Producer and consumer in one Function
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 * import * as Schema from "effect/Schema";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * class Orders extends Vercel.Topic<Orders>()("orders", {
 *   schema: Schema.Struct({ orderId: Schema.String, amountCents: Schema.Int }),
 *   region: "iad1",
 * }) {}
 *
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const orders = yield* Vercel.SendMessage(Orders);
 *
 *     yield* Vercel.subscribe(Orders, (order) =>
 *       Effect.log(`processing order ${order.orderId}`),
 *     );
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders
 *           .send({ orderId: crypto.randomUUID(), amountCents: 4200 })
 *           .pipe(Effect.orDie);
 *         return yield* HttpServerResponse.json({ queued: true });
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide([Vercel.SendMessageHttp, Vercel.QueueEventSourceLive]),
 *   ),
 * ) {}
 * ```
 *
 * @example Delivery metadata and retry tuning
 * ```typescript
 * yield* Vercel.subscribe(
 *   Orders,
 *   (order, meta) =>
 *     Effect.log(
 *       `order ${order.orderId} (message ${meta.messageId}, attempt ${meta.deliveryCount})`,
 *     ),
 *   { retryAfterSeconds: 30, initialDelaySeconds: 5 },
 * );
 * ```
 *
 * @see https://vercel.com/docs/queues
 */
export const subscribe = <S extends Schema.Top, Req = never>(
  topic: Topic<S>,
  handler: (
    payload: S["Type"],
    meta: QueueDeliveryMeta,
  ) => Effect.Effect<void, unknown, Req>,
  options?: SubscribeOptions,
): Effect.Effect<
  void,
  never,
  QueueEventSource | Exclude<Req, RuntimeContext> | S["DecodingServices"]
> => QueueEventSource.use((source) => source(topic, handler, options));

export type QueueEventSourceService = <S extends Schema.Top, Req = never>(
  topic: Topic<S>,
  handler: (
    payload: S["Type"],
    meta: QueueDeliveryMeta,
  ) => Effect.Effect<void, unknown, Req>,
  options?: SubscribeOptions,
) => Effect.Effect<
  void,
  never,
  Exclude<Req, RuntimeContext> | S["DecodingServices"]
>;

export class QueueEventSource extends Context.Service<
  QueueEventSource,
  QueueEventSourceService
>()("Vercel.Queues.QueueEventSource") {}

export const QueueEventSourceLive = Layer.effect(
  QueueEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    // Stable default consumer group: per-Function, deterministic across
    // deploys (a fresh group would replay the topic from the beginning).
    const defaultConsumerGroup = `alchemy-${sanitizeConsumerGroup(host.LogicalId)}`;
    return Effect.fn(function* <S extends Schema.Top, Req>(
      topic: Topic<S>,
      handler: (
        payload: S["Type"],
        meta: QueueDeliveryMeta,
      ) => Effect.Effect<void, unknown, Req>,
      options?: SubscribeOptions,
    ) {
      const consumer = options?.consumerGroup ?? defaultConsumerGroup;
      // Deploy-time: contribute the trigger to the host Function's binding
      // channel — the provider lowers it into the separate consumer
      // function's `.vc-config.json`. Skipped inside the deployed bundle.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          host.bind(`Subscribe(${topic.topicName})`, {
            queues: [
              {
                topic: topic.topicName,
                consumer,
                ...(options?.retryAfterSeconds !== undefined
                  ? { retryAfterSeconds: options.retryAfterSeconds }
                  : {}),
                ...(options?.initialDelaySeconds !== undefined
                  ? { initialDelaySeconds: options.initialDelaySeconds }
                  : {}),
              },
            ],
          }),
        );
      }

      const ctx = (yield* RuntimeContext) as unknown as VercelFunctionContext;
      yield* ctx.registerQueueSubscription({
        topic,
        consumerGroup: consumer,
        handler: handler as (
          payload: any,
          meta: QueueDeliveryMeta,
        ) => Effect.Effect<void, unknown, any>,
      });
    }) as QueueEventSourceService;
  }),
);
