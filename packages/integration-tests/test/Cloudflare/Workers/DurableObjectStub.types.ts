import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// Storage methods need `RuntimeContext` inside the object, which provides it
// itself when an RPC call arrives. A caller's stub must not ask for it (#3312).
export class StubCounter extends Cloudflare.DurableObject<StubCounter>()(
  "StubCounter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.succeed({
      increment: () =>
        Effect.gen(function* () {
          const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
          yield* state.storage.put("count", next);
          return next;
        }).pipe(Effect.orDie),
      counts: () =>
        Stream.fromEffect(state.storage.get<number>("count").pipe(Effect.orDie)).pipe(
          Stream.map((count) => count ?? 0),
        ),
    });
  }),
) {}

export const _increment = (
  counters: Cloudflare.DurableObject<StubCounter>,
): Effect.Effect<number> => counters.getByName("a").increment();

export const _counts = (counters: Cloudflare.DurableObject<StubCounter>): Stream.Stream<number> =>
  counters.getByName("a").counts();
