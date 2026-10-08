import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/index";

const COUNT_KEY = "count";

export class Counter extends Cloudflare.DurableObject<
  Counter,
  {
    increment: () => Effect.Effect<number, never, RuntimeContext>;
    get: () => Effect.Effect<number, never, RuntimeContext>;
  }
>()("Counter") {}

export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const read = () =>
        state.storage.get<number>(COUNT_KEY).pipe(Effect.map((value) => value ?? 0));

      return {
        increment: () =>
          Effect.gen(function* () {
            const next = (yield* read()) + 1;
            yield* state.storage.put(COUNT_KEY, next);
            return next;
          }),
        get: read,
      };
    });
  }),
);
