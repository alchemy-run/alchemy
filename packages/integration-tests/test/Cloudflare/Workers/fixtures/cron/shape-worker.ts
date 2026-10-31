import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RpcWireShape } from "@alchemy.run/cloudflare/Workers/InferEnv";
import type { RpcAsync } from "@alchemy.run/cloudflare/Workers/RpcAsync";
import type { RpcMethods } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Records each `scheduledTime` the shape-level `scheduled` handler sees.
 */
export class ShapeCronCounter extends Cloudflare.DurableObject<ShapeCronCounter>()(
  "ShapeCronCounter",
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

type ShapeCronWorkerShape = {
  greet: (name: string) => Effect.Effect<string>;
  scheduled: (controller: { scheduledTime: number }) => Effect.Effect<void, never, RuntimeContext>;
};

/**
 * Fixture worker that returns `scheduled` from its init shape and attaches
 * the schedule with the `crons` prop — no `Cloudflare.Workers.cron()`. It
 * binds itself so `GET /rpc` can show that `scheduled` is an event handler,
 * not an RPC method, while `greet` still is one.
 */
export class ShapeCronWorker extends Cloudflare.Worker<ShapeCronWorker, ShapeCronWorkerShape>()(
  "ShapeCronWorker",
) {}

export default ShapeCronWorker.make(
  { main: import.meta.url, crons: ["* * * * *"] },
  Effect.gen(function* () {
    const counters = yield* ShapeCronCounter;
    const self = yield* Cloudflare.Workers.bindWorker(ShapeCronWorker);

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

        if (request.method === "GET" && url.pathname === "/rpc") {
          const greeting = yield* self.greet("cron");
          return yield* HttpServerResponse.json({
            greeting,
            scheduled: typeof Reflect.get(self, "scheduled"),
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      scheduled: (controller: { scheduledTime: number }) =>
        counters.getByName("default").record(controller.scheduledTime),
    };
  }),
);

// `scheduled` (and every other ExportedHandler method) is dropped from the
// RPC surface types; `greet` stays.
type Assert<T extends true> = T;
type _GreetIsRpc = Assert<"greet" extends keyof RpcMethods<ShapeCronWorkerShape> ? true : false>;
type _ScheduledIsNotRpc = Assert<
  "scheduled" extends keyof RpcMethods<ShapeCronWorkerShape> ? false : true
>;
type _ScheduledIsNotRpcAsync = Assert<
  "scheduled" extends keyof RpcAsync<ShapeCronWorkerShape> ? false : true
>;
type _ScheduledIsNotOnTheWire = Assert<
  "scheduled" extends keyof RpcWireShape<ShapeCronWorkerShape> ? false : true
>;
type _GreetIsOnTheWire = Assert<
  "greet" extends keyof RpcWireShape<ShapeCronWorkerShape> ? true : false
>;
