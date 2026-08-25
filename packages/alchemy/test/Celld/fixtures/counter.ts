import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export class CounterBoom extends Data.TaggedError("CounterBoom")<{
  readonly reason: string;
}> {}

export interface CounterShape {
  increment: () => Effect.Effect<number, never, RuntimeContext>;
  get: () => Effect.Effect<number, never, RuntimeContext>;
  fail: () => Effect.Effect<never, CounterBoom, RuntimeContext>;
  tick: (n: number) => Stream.Stream<number, never, RuntimeContext>;
}

/** The class is a pure tag — the layer below binds the impl to the Worker. */
export class Counter extends Cloudflare.DurableObject<Counter, CounterShape>()(
  "Counter",
) {}

/**
 * The implementation layer — provided on the hosting worker's impl
 * (registers the class there). Remote callers reach it through
 * `Celld.bindWorker(...)`'s stub.
 */
export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
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
      } satisfies CounterShape;
    });
  }),
);
