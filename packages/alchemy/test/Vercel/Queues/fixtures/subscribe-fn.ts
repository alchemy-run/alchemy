/**
 * Effect-mode Vercel Function fixture for the `subscribe` event source
 * (D9a two-function shape): a public fetch route produces into `Orders`
 * via `SendMessage`; the platform push-delivers to the generated consumer
 * function, whose `subscribe` handler echoes each processed payload into
 * `Echoes`; the public `/received` route drains `Echoes` with the
 * `ReceiveMessages` binding into module-global state for HTTP readback.
 *
 * Why the echo topic instead of module-global readback from the handler:
 * the consumer function is a SEPARATE deployment artifact from the public
 * one (separate Fluid instances), so module globals written by the
 * subscribe handler are invisible to the public function. And why not an
 * externally-minted OIDC client: `getProjectToken` mints are ALWAYS
 * `environment: development`-scoped (live-verified), while the queue
 * namespace is per (project, environment) — an external client can never
 * see production queue traffic. All queue traffic here stays inside the
 * deployed functions' ambient production scope.
 *
 * `Echoes` gets its own no-op subscription so the deployment carries a
 * trigger for it too (a topic without a consumer trigger rejects sends with
 * 503 ConsumerRegistryNotConfigured).
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class Orders extends Vercel.Topic<Orders>()("alchemy-subscribe-orders", {
  schema: Schema.Struct({
    orderId: Schema.String,
    amountCents: Schema.Int,
    runId: Schema.String,
  }),
  region: "iad1",
  retentionSeconds: 300,
}) {}

export interface Echo {
  readonly orderId: string;
  readonly runId: string;
  readonly deliveryCount: number;
  readonly topicName: string;
  readonly consumerGroup: string;
}

export class Echoes extends Vercel.Topic<Echoes>()("alchemy-subscribe-echoes", {
  schema: Schema.Struct({
    orderId: Schema.String,
    runId: Schema.String,
    deliveryCount: Schema.Int,
    topicName: Schema.String,
    consumerGroup: Schema.String,
  }),
  region: "iad1",
  retentionSeconds: 300,
}) {}

// Public-instance readback state, filled by the `/received` route's drains.
const received: Echo[] = [];

export default class SubscribeFn extends Vercel.Function<SubscribeFn>()(
  "SubscribeFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const orders = yield* Vercel.SendMessage(Orders);
    const echoes = yield* Vercel.SendMessage(Echoes);
    const echoReader = yield* Vercel.ReceiveMessages(Echoes, {
      consumerGroup: "alchemy-readback",
    });

    // The consumer half: schema-decoded payload + delivery metadata,
    // re-published into the echo topic for cross-function readback.
    yield* Vercel.subscribe(Orders, (order, meta) =>
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

    // Ensure the echo topic has a consumer trigger too (sends into a topic
    // with no trigger fail 503); it acks under the trigger's group while
    // the readback group above keeps its own independent cursor.
    yield* Vercel.subscribe(Echoes, () => Effect.void);

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
        if (url.pathname === "/send-async") {
          // Async-mode producer path: `sendMessageFromEnv` resolves the
          // ambient OIDC token + deployment pin from the live environment
          // and returns a Promise — the exact client a plain (non-Effect)
          // Function would use. Driving it from here pins the fromEnv
          // variant without a second deployed fixture.
          const runId = url.searchParams.get("runId") ?? "missing-run-id";
          const orderId = url.searchParams.get("orderId") ?? "order-async-1";
          const asyncOrders = Vercel.sendMessageFromEnv(Orders);
          yield* Effect.tryPromise(() =>
            asyncOrders.send({ orderId, amountCents: 100, runId }),
          ).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            queued: true,
            orderId,
            runId,
            via: "fromEnv",
          });
        }
        if (url.pathname === "/received") {
          // One bounded drain per call; the test polls this route.
          const batch = yield* echoReader
            .receive({ maxMessages: 10, visibilityTimeoutSeconds: 60 })
            .pipe(Effect.orDie);
          for (const message of batch) {
            received.push(message.payload as Echo);
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
