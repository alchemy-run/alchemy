/**
 * QueueEvolution chain — CYCLE 2 fixture: identical to v1 except the
 * `subscribe` options change (`retryAfterSeconds: 45` on the Orders
 * trigger). The trigger config lives in the consumer function's
 * `.vc-config.json`, so this MUST force a redeploy even though the schema
 * and handler code are unchanged.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  Echoes,
  READBACK_GROUP,
  errorInfo,
  type Echo,
} from "./queue-evo-shared.ts";

export class Orders extends Vercel.Topic<Orders>()("alchemy-qevo-orders", {
  schema: Schema.Struct({
    orderId: Schema.String,
    amountCents: Schema.Int,
    runId: Schema.String,
  }),
  region: "iad1",
  retentionSeconds: 300,
}) {}

const received: Echo[] = [];

export default class QueueEvoFn extends Vercel.Function<QueueEvoFn>()(
  "QueueEvoFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const orders = yield* Vercel.SendMessage(Orders);
    const echoes = yield* Vercel.SendMessage(Echoes);
    const echoReader = yield* Vercel.ReceiveMessages(Echoes, {
      consumerGroup: READBACK_GROUP,
    });

    // The cycle-2 change: retry tuning on the Orders trigger.
    yield* Vercel.subscribe(
      Orders,
      (order, meta) =>
        echoes
          .send({
            orderId: order.orderId,
            runId: order.runId,
            deliveryCount: meta.deliveryCount,
            topicName: meta.topicName,
            consumerGroup: meta.consumerGroup,
          })
          .pipe(Effect.orDie, Effect.asVoid),
      { retryAfterSeconds: 45 },
    );

    yield* Vercel.subscribe(Echoes, () => Effect.void);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/send") {
          const runId = url.searchParams.get("runId") ?? "missing-run-id";
          const orderId = url.searchParams.get("orderId") ?? "order-1";
          const outcome = yield* orders
            .send({ orderId, amountCents: 4200, runId })
            .pipe(
              Effect.map((receipt) => ({
                queued: true as const,
                orderId,
                runId,
                messageId: receipt.messageId,
              })),
              Effect.catch((error) =>
                Effect.succeed({ queued: false as const, ...errorInfo(error) }),
              ),
            );
          return yield* HttpServerResponse.json(outcome);
        }
        if (url.pathname === "/received") {
          const batch = yield* echoReader
            .receive({ maxMessages: 10, visibilityTimeoutSeconds: 60 })
            .pipe(Effect.orDie);
          for (const message of batch) {
            received.push(message.payload as Echo);
            yield* echoReader.ack(message.receiptHandle).pipe(Effect.orDie);
          }
          return yield* HttpServerResponse.json({ received });
        }
        return yield* HttpServerResponse.json({ ok: true, stage: 2 });
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
