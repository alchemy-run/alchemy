/** Compile-pin for the single-file Fleet + Celld.Worker + inline cell DX (the PR/docs sample). */
import * as Celld from "@/Celld";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class Cells extends Celld.Fleet<Cells>()("Cells", {
  instances: 2,
}) {}

export class Counter extends Cloudflare.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
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

// The native inline form: props (naming the fleet) + impl in one
// declaration — the same shape a Cloudflare Worker uses.
export default class CellsWorker extends Celld.Worker<CellsWorker>()(
  "CellsWorker",
  { fleet: Cells, main: import.meta.url },
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
