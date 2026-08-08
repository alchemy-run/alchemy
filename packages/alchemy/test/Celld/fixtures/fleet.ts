import * as Celld from "@/Celld";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Cells } from "./cells.ts";
import { Counter, CounterLive } from "./counter.ts";
import { CellsWorker } from "./worker.ts";

/**
 * The deploy module: the definition (`CellsWorker.make`) is cloud-free;
 * `Celld.Worker(CellsWorker, { fleet }, …)` is the only line that makes
 * this a celld deployment — a different deploy wrapper ships the same
 * worker elsewhere.
 */
export default Celld.Worker(
  CellsWorker,
  { fleet: Cells, main: import.meta.url },
  CellsWorker.make(
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
  ),
);
