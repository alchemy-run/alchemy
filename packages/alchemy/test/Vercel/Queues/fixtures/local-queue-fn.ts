/**
 * Effect-mode Vercel Function fixture for the dev-mode queue tests — the
 * `subscribe-fn.ts` flagship shape (produce over HTTP → push delivery →
 * echo topic → HTTP readback), deployed BOTH against the local dev broker
 * (`Queue.local.test.ts` local arm: `SendMessage` targets the sidecar's
 * broker via `VERCEL_QUEUE_BASE_URL`, the broker POSTs the CloudEvent to
 * the dev child's queue endpoint) and — piped through `Alchemy.remote()` —
 * against the real platform from a dev run.
 *
 * See `fixtures/subscribe-fn.ts` for why readback rides an echo topic and
 * stays inside the Function's ambient scope.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class DevOrders extends Vercel.Topic<DevOrders>()(
  "alchemy-devq-orders",
  {
    schema: Schema.Struct({
      orderId: Schema.String,
      amountCents: Schema.Int,
      runId: Schema.String,
    }),
    region: "iad1",
    retentionSeconds: 300,
  },
) {}

export interface DevEcho {
  readonly orderId: string;
  readonly runId: string;
  readonly deliveryCount: number;
  readonly topicName: string;
  readonly consumerGroup: string;
}

export class DevEchoes extends Vercel.Topic<DevEchoes>()(
  "alchemy-devq-echoes",
  {
    schema: Schema.Struct({
      orderId: Schema.String,
      runId: Schema.String,
      deliveryCount: Schema.Int,
      topicName: Schema.String,
      consumerGroup: Schema.String,
    }),
    region: "iad1",
    retentionSeconds: 300,
  },
) {}

// Public-instance readback state, filled by the `/received` route's drains.
const received: DevEcho[] = [];

export default class LocalQueueFn extends Vercel.Function<LocalQueueFn>()(
  "LocalQueueFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const orders = yield* Vercel.SendMessage(DevOrders);
    const echoes = yield* Vercel.SendMessage(DevEchoes);
    const echoReader = yield* Vercel.ReceiveMessages(DevEchoes, {
      consumerGroup: "alchemy-devq-readback",
    });

    // The consumer half: schema-decoded payload + delivery metadata,
    // re-published into the echo topic for cross-instance readback.
    yield* Vercel.subscribe(DevOrders, (order, meta) =>
      echoes
        .send({
          orderId: order.orderId,
          runId: order.runId,
          deliveryCount: meta.deliveryCount,
          topicName: meta.topicName,
          consumerGroup: meta.consumerGroup,
        })
        .pipe(Effect.orDie, Effect.asVoid),
    );

    // The echo topic needs a consumer trigger too (live sends into a topic
    // with no trigger fail 503 ConsumerRegistryNotConfigured).
    yield* Vercel.subscribe(DevEchoes, () => Effect.void);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/send") {
          const runId = url.searchParams.get("runId") ?? "missing-run-id";
          const orderId = url.searchParams.get("orderId") ?? "order-1";
          yield* orders
            .send({ orderId, amountCents: 4200, runId })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            queued: true,
            orderId,
            runId,
          });
        }
        if (url.pathname === "/received") {
          // One bounded drain per call; the test polls this route.
          const batch = yield* echoReader
            .receive({ maxMessages: 10, visibilityTimeoutSeconds: 60 })
            .pipe(Effect.orDie);
          for (const message of batch) {
            received.push(message.payload as DevEcho);
            yield* echoReader.ack(message.receiptHandle).pipe(Effect.orDie);
          }
          return yield* HttpServerResponse.json({ received });
        }
        return yield* HttpServerResponse.json({ ok: true, path: request.url });
      }),
    };
  }).pipe(
    Effect.provide([
      Vercel.SendMessageHttp,
      Vercel.ReceiveMessagesHttp,
      Vercel.QueueEventSourceLive,
    ]),
  ),
) {}
