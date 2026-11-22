import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Jobs, resultKey, Results, type JobMessage, type JobResult } from "./resources.ts";

/**
 * The producer: the public front of the job queue.
 *
 * - `POST /jobs` — enqueue `{ payload }` and return `202 { id }`.
 * - `GET /jobs/:id` — `200` with the result once the worker is done,
 *   `202 { status: "pending" }` until then.
 *
 * The API never processes a job itself, so a slow or crashed worker only
 * delays results; submissions keep succeeding.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const jobsQueue = yield* Jobs;
    const resultsContainer = yield* Results;
    // Storage Queue Data Message Sender on the queue, for the app's identity.
    const jobs = yield* Azure.Storage.QueueSend(jobsQueue);
    const results = yield* Azure.Storage.BlobContainerRead(resultsContainer);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && segments.length === 1 && segments[0] === "jobs") {
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
            payload?: unknown;
          };
          if (typeof body.payload !== "string") {
            return yield* HttpServerResponse.json(
              { error: "payload must be a string" },
              { status: 400 },
            );
          }

          const job: JobMessage = {
            id: crypto.randomUUID(),
            payload: body.payload,
            submittedAt: new Date().toISOString(),
          };
          yield* jobs.send(JSON.stringify(job));
          return yield* HttpServerResponse.json({ id: job.id, status: "pending" }, { status: 202 });
        }

        if (request.method === "GET" && segments.length === 2 && segments[0] === "jobs") {
          const id = segments[1]!;
          const blob = yield* results.get(resultKey(id));
          // No blob yet means the job is queued or in flight. The API keeps
          // no record of submissions, so an unknown id also reads as pending.
          if (blob === undefined) {
            return yield* HttpServerResponse.json({ id, status: "pending" }, { status: 202 });
          }
          const result = JSON.parse(blob.text()) as JobResult;
          return yield* HttpServerResponse.json({ id, ...result });
        }

        return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
      }).pipe(
        // A failed Storage call answers 503, e.g. while the app's data roles
        // propagate after the first deploy, so callers retry.
        Effect.catch((error) => HttpServerResponse.json({ error: String(error) }, { status: 503 })),
      ),
    };
  }).pipe(Effect.provide([Azure.Storage.QueueSendHttp, Azure.Storage.BlobContainerReadHttp])),
) {}
