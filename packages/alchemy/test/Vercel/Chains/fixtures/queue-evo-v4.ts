/**
 * QueueEvolution chain — CYCLE 4 fixture: ALL `subscribe` calls removed.
 * The deployment must carry no `_alchemy-queue.func` consumer function at
 * all; the public routes keep serving. `/send` reports the platform's
 * verdict on producing into a trigger-less topic honestly (queued vs the
 * typed rejection) so the test can pin the real behavior either way.
 *
 * Keeps the v3 (evolved) Orders schema — evolution is not rolled back by
 * removing the consumer.
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
    const echoReader = yield* Vercel.ReceiveMessages(Echoes, {
      consumerGroup: READBACK_GROUP,
    });

    // NO subscribe calls — the consumer function must vanish from the
    // deployment.

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
          const outcome = yield* echoReader
            .receive({ maxMessages: 10, visibilityTimeoutSeconds: 60 })
            .pipe(
              Effect.map((batch) => ({
                ok: true as const,
                count: batch.length,
                received,
              })),
              Effect.catch((error) =>
                Effect.succeed({ ok: false as const, ...errorInfo(error) }),
              ),
            );
          return yield* HttpServerResponse.json(outcome);
        }
        return yield* HttpServerResponse.json({ ok: true, stage: 4 });
      }),
    };
  }).pipe(Effect.provide([Vercel.SendMessageHttp, Vercel.ReceiveMessagesHttp])),
) {}
