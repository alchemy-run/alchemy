/** The greeter's implementation: it calls the counter by name, inside the cluster. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { Counters } from "./counter.ts";
import { Greeters } from "./greeter.ts";

export const greeterLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Greeters.make(
    { main },
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
    }).pipe(Effect.provide(pool)),
  );
