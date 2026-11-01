import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { PullLogin, registryFor } from "./registry.ts";
import { Jobs, resultKey, Results, type JobMessage } from "./resources.ts";

/**
 * The producer.
 *
 * - `POST /jobs` publishes `{ payload }` and answers `202 { id }`.
 * - `GET /jobs/:id` answers `200` with the result once the worker wrote it,
 *   `202 { status: "pending" }` until then.
 */
export default class Api extends Stackit.ContainerApplications.Application<Api>()(
  "Api",
  Effect.gen(function* () {
    const login = yield* PullLogin;
    const registry = yield* registryFor("api");
    return {
      main: import.meta.url,
      environmentId: login.environmentId,
      registry,
    };
  }),
  Effect.gen(function* () {
    const publish = yield* Stackit.PubSub.Publish(yield* Jobs);
    const results = yield* Stackit.ObjectStorage.ReadBucket(yield* Results);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://application");
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/jobs") {
          const body = (yield* request.json) as { payload?: unknown };
          if (typeof body.payload !== "string") {
            return yield* HttpServerResponse.json(
              { error: "payload must be a string" },
              { status: 400 },
            );
          }
          const job: JobMessage = { id: crypto.randomUUID(), payload: body.payload };
          yield* publish({ messages: [{ data: JSON.stringify(job) }] });
          return yield* HttpServerResponse.json({ id: job.id, status: "pending" }, { status: 202 });
        }

        if (request.method === "GET" && segments[0] === "jobs" && segments.length === 2) {
          const id = segments[1]!;
          const result = yield* results.getObject({ Key: resultKey(id) }).pipe(
            Effect.flatMap((object) => Stream.mkString(Stream.decodeText(object.Body!))),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
          );
          return result === undefined
            ? yield* HttpServerResponse.json({ id, status: "pending" }, { status: 202 })
            : HttpServerResponse.text(result, { contentType: "application/json" });
        }

        return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide([Stackit.PubSub.PublishHttp, Stackit.ObjectStorage.ReadBucketHttp])),
) {}
