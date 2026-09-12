import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Durable Object that records each `scheduledTime` the shape-level
 * `scheduled` handler sees. The test polls `snapshot()` via the worker's
 * `GET /times` route to verify the cron actually dispatched to the shape
 * method (not a `CronEventSource` listener).
 */
export class ShapeScheduledCounter extends Cloudflare.DurableObject<ShapeScheduledCounter>()(
  "ShapeScheduledCounter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      let times = (yield* state.storage.get<number[]>("times")) ?? [];
      return {
        record: Effect.fn(function* (time: number) {
          times = [...times, time];
          yield* state.storage.put("times", times);
        }),
        snapshot: () => Effect.succeed({ times }),
        reset: Effect.fn(function* () {
          times = [];
          yield* state.storage.put("times", times);
        }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `WorkerShapeHandlers.test.ts`.
 *
 * Returns `scheduled` on the Worker init shape (the #414 reproduction) plus
 * an RPC method `greet` so tests can assert handler methods are registered
 * as listeners while remaining excluded from the RPC interface. Cron
 * Triggers are attached via the `crons` prop — not `CronEventSource`.
 */
export default class ShapeScheduledWorker extends Cloudflare.Worker<ShapeScheduledWorker>()(
  "ShapeScheduledWorker",
  {
    main: import.meta.url,
    crons: ["* * * * *"],
  },
  Effect.gen(function* () {
    const counters = yield* ShapeScheduledCounter;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/times") {
          const snapshot = yield* counters.getByName("default").snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* counters.getByName("default").reset();
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
      scheduled: (controller: { scheduledTime: number }) =>
        counters.getByName("default").record(controller.scheduledTime),
      greet: (name: string) => Effect.succeed(`hello ${name}`),
    };
  }),
) {}
