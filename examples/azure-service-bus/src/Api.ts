import * as Azure from "@alchemy.run/azure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  Events,
  Orders,
  RESULT_KINDS,
  Results,
  resultKey,
  type EventMessage,
  type OrderMessage,
  type ResultKind,
} from "./resources.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.json(body, { status });

const isResultKind = (value: string | undefined): value is ResultKind =>
  RESULT_KINDS.some((kind) => kind === value);

/**
 * The public front of the example.
 *
 * - `POST /orders` — send `{ item, quantity }` to the `Orders` queue, `202 { id }`.
 * - `POST /events` — publish `{ type }` to the `Events` topic, `202 { id }`.
 * - `GET /results/:kind/:id` — the worker's result for a message (`orders`,
 *   `audit` or `notify`), `202 { status: "pending" }` until it exists.
 *
 * A Service Bus or Storage error answers `503` with the error, so a caller
 * can retry while the app's role assignments propagate after a deploy.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const ordersQueue = yield* Orders;
    const eventsTopic = yield* Events;
    const resultsContainer = yield* Results;
    const orders = yield* Azure.ServiceBus.QueueSend(ordersQueue);
    const events = yield* Azure.ServiceBus.TopicWrite(eventsTopic);
    const results = yield* Azure.Storage.BlobContainerRead(resultsContainer);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && segments.length === 1 && segments[0] === "orders") {
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
            item?: unknown;
            quantity?: unknown;
          };
          if (typeof body.item !== "string" || typeof body.quantity !== "number") {
            return yield* json({ error: "expected { item: string, quantity: number }" }, 400);
          }
          const id = yield* Effect.sync(() => crypto.randomUUID());
          const order: OrderMessage = { id, item: body.item, quantity: body.quantity };
          // `messageId` lets Service Bus drop duplicates on queues that
          // enable duplicate detection.
          yield* orders.send(order, { messageId: id });
          return yield* json({ id, status: "pending" }, 202);
        }

        if (request.method === "POST" && segments.length === 1 && segments[0] === "events") {
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
            type?: unknown;
          };
          if (typeof body.type !== "string") {
            return yield* json({ error: "expected { type: string }" }, 400);
          }
          const id = yield* Effect.sync(() => crypto.randomUUID());
          const event: EventMessage = { id, type: body.type };
          // The label (subject) is what subscription rules usually filter on.
          yield* events.send(event, { messageId: id, label: body.type });
          return yield* json({ id, status: "pending" }, 202);
        }

        if (request.method === "GET" && segments.length === 3 && segments[0] === "results") {
          const kind = segments[1];
          const id = segments[2]!;
          if (!isResultKind(kind)) {
            return yield* json({ error: `unknown result kind ${kind}` }, 404);
          }
          const blob = yield* results.get(resultKey(kind, id));
          if (blob === undefined) {
            return yield* json({ id, status: "pending" }, 202);
          }
          return yield* json({ id, ...JSON.parse(blob.text()) });
        }

        return yield* json({ error: "not found" }, 404);
      }).pipe(Effect.catchCause((cause) => json({ error: Cause.pretty(cause) }, 503))),
    };
  }).pipe(
    Effect.provide([
      Azure.ServiceBus.QueueSendHttp,
      Azure.ServiceBus.TopicWriteHttp,
      Azure.Storage.BlobContainerReadHttp,
    ]),
  ),
) {}
