import * as Azure from "@alchemy.run/azure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Readings, Results, resultKey, type ReadingEvent } from "./resources.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.json(body, { status });

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "number");

/**
 * The producer, and the public front of the example.
 *
 * - `POST /devices/:deviceId/readings` — send `{ temperature }` as one event,
 *   or `{ temperatures: [...] }` as one batch, to the `Readings` event hub.
 *   The device ID is the partition key. Answers `202 { ids }`.
 * - `GET /readings/:id` — the worker's result for a reading,
 *   `202 { status: "pending" }` until it exists.
 *
 * An Event Hubs or Storage error answers `503` with the error, so a caller
 * can retry while the app's role assignments propagate after a deploy.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const readingsHub = yield* Readings;
    const resultsContainer = yield* Results;
    const readings = yield* Azure.EventHub.Send(readingsHub);
    const results = yield* Azure.Storage.BlobContainerRead(resultsContainer);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (
          request.method === "POST" &&
          segments.length === 3 &&
          segments[0] === "devices" &&
          segments[2] === "readings"
        ) {
          const deviceId = segments[1]!;
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
            temperature?: unknown;
            temperatures?: unknown;
          };
          const temperatures =
            typeof body.temperature === "number"
              ? [body.temperature]
              : isNumberArray(body.temperatures)
                ? body.temperatures
                : undefined;
          if (temperatures === undefined) {
            return yield* json(
              { error: "expected { temperature: number } or { temperatures: number[] }" },
              400,
            );
          }
          const events: ReadingEvent[] = [];
          for (const temperature of temperatures) {
            const id = yield* Effect.sync(() => crypto.randomUUID());
            events.push({ id, deviceId, temperature });
          }
          // The partition key routes every reading of a device to the same
          // partition, so the consumer sees them in send order.
          if (events.length === 1) {
            yield* readings.send(events[0]!, { partitionKey: deviceId });
          } else {
            yield* readings.sendBatch(events, { partitionKey: deviceId });
          }
          return yield* json({ ids: events.map((event) => event.id), status: "pending" }, 202);
        }

        if (request.method === "GET" && segments.length === 2 && segments[0] === "readings") {
          const id = segments[1]!;
          const blob = yield* results.get(resultKey(id));
          if (blob === undefined) {
            return yield* json({ id, status: "pending" }, 202);
          }
          return yield* json(JSON.parse(blob.text()));
        }

        return yield* json({ error: "not found" }, 404);
      }).pipe(Effect.catchCause((cause) => json({ error: Cause.pretty(cause) }, 503))),
    };
  }).pipe(Effect.provide([Azure.EventHub.SendHttp, Azure.Storage.BlobContainerReadHttp])),
) {}
