/**
 * QueueEvolution chain — CYCLE 3 fixture: the Orders Topic schema EVOLVES
 * (optional `note` field added), both ends redeploy together. Keeps the
 * cycle-2 retry tuning so the only diff vs v2 is the schema (+ the raw-send
 * route).
 *
 * `/send-raw` emits an OLD-shape (v1) wire message — raw JSON bytes with no
 * `note` and no schema encode, exactly what a not-yet-evolved producer
 * would put on the wire — proving backward-compatible decode through the
 * push consumer.
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
  sendRawJson,
  type Echo,
} from "./queue-evo-shared.ts";

export class Orders extends Vercel.Topic<Orders>()("alchemy-qevo-orders", {
  schema: Schema.Struct({
    orderId: Schema.String,
    amountCents: Schema.Int,
    runId: Schema.String,
    // The evolution: new OPTIONAL field — old-shape messages must still
    // decode.
    note: Schema.optional(Schema.String),
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

    yield* Vercel.subscribe(
      Orders,
      (order, meta) =>
        echoes
          .send({
            orderId: order.orderId,
            runId: order.runId,
            ...(order.note !== undefined ? { note: order.note } : {}),
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
          const note = url.searchParams.get("note") ?? undefined;
          const outcome = yield* orders
            .send({
              orderId,
              amountCents: 4200,
              runId,
              ...(note !== undefined ? { note } : {}),
            })
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
        if (url.pathname === "/send-raw") {
          // OLD-shape wire message: v1 fields only, raw JSON, no encode.
          const runId = url.searchParams.get("runId") ?? "missing-run-id";
          const orderId = url.searchParams.get("orderId") ?? "order-raw";
          yield* sendRawJson(Orders, {
            orderId,
            amountCents: 1100,
            runId,
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            queued: true,
            raw: true,
            orderId,
            runId,
          });
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
        return yield* HttpServerResponse.json({ ok: true, stage: 3 });
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
