/** The greeter's implementation: it calls the counter by name, inside the cluster. */
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";
import { Counters } from "./counter.ts";
import { Greeters } from "./greeter.ts";

export default Greeters.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counters;
    return Effect.gen(function* () {
      return Greeters.of({
        Greet: ({ payload }) =>
          counters.getByName(`greetings-${payload.name}`).pipe(
            Effect.flatMap((counter) => counter.Increment({ amount: 1 })),
            Effect.map((n) => `hello ${payload.name} #${n}`),
            Effect.orDie,
          ),
      });
    });
  }).pipe(Effect.provide(Default)),
);
