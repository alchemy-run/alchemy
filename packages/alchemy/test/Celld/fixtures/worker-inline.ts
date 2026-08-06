/** Compile-pin for the single-file Fleet + `Celld.Worker` + inline cell DX (the PR/docs sample). Not deployed by tests. */
import * as Celld from "@/Celld";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class Cells extends Celld.Fleet<Cells>()("Cells", {
  instances: 2,
}) {}

export class Counter extends Celld.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Celld.DurableObjectState;
    return Effect.gen(function* () {
      const count = (yield* state.storage.get<number>("count")) ?? 0;
      return {
        increment: () =>
          Effect.gen(function* () {
            const next = count + 1;
            yield* state.storage.put("count", next);
            return next;
          }),
      };
    });
  }),
) {}

export default class CellsWorker extends Celld.Worker<CellsWorker>()(
  "CellsWorker",
  { fleet: () => Cells, main: import.meta.url },
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
) {}
