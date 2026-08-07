import * as Alchemy from "@/index.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "@/RuntimeContext";
import { CellsWorker } from "./worker.ts";

export class CounterBoom extends Data.TaggedError("CounterBoom")<{
  readonly reason: string;
}> {}

/** The class is a pure tag — the layer below binds the impl to the Worker. */
export class Counter extends Alchemy.DurableObject<
  Counter,
  {
    increment: () => Effect.Effect<number, never, RuntimeContext>;
    get: () => Effect.Effect<number, never, RuntimeContext>;
    fail: () => Effect.Effect<never, CounterBoom, RuntimeContext>;
    tick: (n: number) => Stream.Stream<number, never, RuntimeContext>;
  }
>()("Counter") {}

/**
 * The implementation layer, bound to {@link CellsWorker}. Provided on the
 * worker impl (hosts the class) and on callers (resolves the remote stub);
 * a second worker would get its own `Counter.make(OtherWorker, …)`.
 */
export const CounterLive = Counter.make(
  CellsWorker,
  Effect.gen(function* () {
    const state = yield* Alchemy.DurableObjectState;
    return Effect.gen(function* () {
      return {
        increment: () =>
          Effect.gen(function* () {
            const current = (yield* state.storage.get<number>("count")) ?? 0;
            const next = current + 1;
            yield* state.storage.put("count", next);
            return next;
          }),
        get: () =>
          Effect.gen(function* () {
            return (yield* state.storage.get<number>("count")) ?? 0;
          }),
        fail: () => Effect.fail(new CounterBoom({ reason: "expected" })),
        tick: (n: number) =>
          Stream.range(1, n).pipe(
            Stream.schedule(Schedule.spaced("20 millis")),
          ),
      };
    });
  }),
);
