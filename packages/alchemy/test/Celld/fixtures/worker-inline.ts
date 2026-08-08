/** Compile-pin for the single-file Fleet + Alchemy.Worker + inline cell DX (the PR/docs sample). Not deployed by tests. */
import * as Alchemy from "@/index.ts";
import * as Celld from "@/Celld";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class Cells extends Celld.Fleet<Cells>()("Cells", {
  instances: 2,
}) {}

export class Counter extends Alchemy.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Alchemy.DurableObjectState;
    return Effect.gen(function* () {
      return {
        increment: () =>
          Effect.gen(function* () {
            const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
            yield* state.storage.put("count", next);
            return next;
          }),
      };
    });
  }),
) {}

export class CellsWorker extends Alchemy.Worker<CellsWorker>()("CellsWorker") {}

// The deploy module: the definition above is cloud-free; this line is
// what makes it a celld deployment.
export default Celld.Worker(
  CellsWorker,
  { fleet: Cells, main: import.meta.url },
  CellsWorker.make(
    Effect.gen(function* () {
      const counters = yield* Counter;
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const room =
            new URL(request.url, "http://cells").pathname.slice(1) || "lobby";
          const value = yield* counters.getByName(room).increment();
          return yield* HttpServerResponse.json({ room, value });
        }),
      };
    }),
  ),
);
