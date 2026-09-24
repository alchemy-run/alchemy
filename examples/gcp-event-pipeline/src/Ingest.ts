import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Drain from "./Drain.ts";
import { Analytics, Events, EventsTable, type EventRow } from "./resources.ts";

/**
 * The front door of an analytics pipeline.
 *
 * Producers post events; the service publishes them to Pub/Sub and
 * returns. Nothing touches BigQuery on the request path, so a slow
 * warehouse or a schema change cannot take the ingest endpoint down —
 * the messages just queue up until {@link Drain} runs.
 *
 * - `POST /events` — accept an event and publish it.
 * - `POST /drain` — start a drain now, instead of waiting for a schedule.
 * - `GET /events/count` — count what has landed in BigQuery.
 */
export default class Ingest extends GCP.Function<Ingest>()(
  "Ingest",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const topic = yield* Events;
    const dataset = yield* Analytics;
    const table = yield* EventsTable;
    const drain = yield* Drain;

    const publish = yield* GCP.PubSub.Publish(topic);
    const query = yield* GCP.BigQuery.Query(dataset);
    // Binding a Job to a Service grants run.jobs.run on the job — this is
    // how one host triggers another.
    const runDrain = yield* GCP.Run.RunJob(drain);

    // An accessor: the table id is bound at deploy time and read back
    // inside the handler.
    const tableId = yield* table.tableId;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/events") {
          const body = (yield* request.json) as {
            type?: string;
            payload?: unknown;
          };
          if (!body.type) {
            return yield* HttpServerResponse.json(
              { error: "type is required" },
              { status: 400 },
            );
          }

          const event: EventRow = {
            id: crypto.randomUUID(),
            type: body.type,
            occurredAt: new Date().toISOString(),
            payload: JSON.stringify(body.payload ?? {}),
          };

          yield* publish({
            body: {
              messages: [
                {
                  data: btoa(JSON.stringify(event)),
                  // Attributes are queryable without decoding the body,
                  // which lets a filtered subscription fan out by type.
                  attributes: { type: event.type },
                },
              ],
            },
          }).pipe(Effect.orDie);

          return yield* HttpServerResponse.json(
            { id: event.id },
            { status: 202 },
          );
        }

        // Cloud Run Jobs are asynchronous: this returns as soon as the
        // execution is created, not when it finishes.
        if (request.method === "POST" && url.pathname === "/drain") {
          const operation = yield* runDrain().pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            { execution: operation.name ?? null },
            { status: 202 },
          );
        }

        if (request.method === "GET" && url.pathname === "/events/count") {
          const type = url.searchParams.get("type");
          const events = yield* tableId;
          // The dataset is implied by the binding, so the table name
          // alone qualifies it.
          const rows = yield* query({
            query: type
              ? `SELECT COUNT(*) AS n FROM \`${events}\` WHERE type = @type`
              : `SELECT COUNT(*) AS n FROM \`${events}\``,
            parameterMode: type ? "NAMED" : undefined,
            queryParameters: type
              ? [
                  {
                    name: "type",
                    parameterType: { type: "STRING" },
                    parameterValue: { value: type },
                  },
                ]
              : undefined,
          }).pipe(Effect.orDie);

          return yield* HttpServerResponse.json({
            count: Number(rows.rows?.[0]?.f?.[0]?.v ?? 0),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      GCP.PubSub.PublishHttp,
      GCP.BigQuery.QueryHttp,
      GCP.Run.RunJobHttp,
    ]),
  ),
) {}
