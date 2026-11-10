import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * Durable Object that records each `scheduledTime` the cron handler sees.
 * The test polls `snapshot()` via the worker's `GET /times` route to verify
 * the cron actually fired.
 */
export class CronCounter extends Cloudflare.DurableObject<CronCounter>()(
  "CronCounter",
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
 * A service the Worker's init effect provides to itself. The
 * `ProvidedServiceCron` handler reads it at fire time, so the fire only
 * records when init-provided services reach cron handlers (#2941).
 */
export class CounterName extends Context.Service<CounterName, { readonly name: string }>()(
  "CronTestWorker/CounterName",
) {}

/** Expression of the `CounterName` handler. Tests fire it manually. */
export const ProvidedServiceCron = "0 0 1 1 *";

/**
 * Fixture worker for `CronEventSource.test.ts` and `CronEventSource.local.test.ts`.
 *
 * Cloudflare's minimum cron granularity is one minute, so the default trigger
 * is `* * * * *`. Each fire records `controller.scheduledTime` on the
 * `CronCounter` DO; the `ProvidedServiceCron` handler records on the counter
 * its init-provided `CounterName` names (#2941). Tests poll
 * `GET /times?counter=<name>` until an entry appears.
 */
export default class CronTestWorker extends Cloudflare.Worker<CronTestWorker>()(
  "CronTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const counters = yield* CronCounter;

    yield* Cloudflare.Workers.cron("* * * * *", (controller) =>
      counters.getByName("default").record(controller.scheduledTime),
    );

    yield* Cloudflare.Workers.cron(ProvidedServiceCron, (controller) =>
      Effect.gen(function* () {
        const { name } = yield* CounterName;
        yield* counters.getByName(name).record(controller.scheduledTime);
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("counter") ?? "default";

        if (request.method === "GET" && url.pathname === "/times") {
          const snapshot = yield* counters.getByName(name).snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* counters.getByName(name).reset();
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.Workers.CronEventSourceLive,
      Layer.succeed(CounterName, { name: "provided" }),
    ]),
  ),
) {}
