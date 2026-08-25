import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Cells } from "./cells.ts";
import { Counter, CounterLive } from "./counter.ts";
import { CellsWorker } from "./worker.ts";

/**
 * The deploy module: the native `CellsWorker.make(props, impl)` form —
 * the fleet is named on the props, the Durable Object is the same
 * `Cloudflare.DurableObject` a Cloudflare deployment would host.
 */
export default CellsWorker.make(
  { fleet: Cells, main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://fleet");
        if (url.pathname === "/hello") {
          const value = yield* counters
            .getByName("worker-route")
            .increment()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            from: "fleet-worker",
            value,
          });
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(CounterLive)),
);
