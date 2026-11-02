/** A second entity on the same runners, which calls the counter itself. */
import * as EffectCluster from "@alchemy.run/effect-cluster";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Default } from "./cluster.ts";
import Counters from "./counter.ts";

export const Greeter = Entity.make("Greeter", [
  Rpc.make("Greet", { payload: { name: Schema.String }, success: Schema.String }),
]);

export default class Greeters extends EffectCluster.Entity<Greeters>()(
  Greeter,
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counters;
    return Effect.gen(function* () {
      return Greeter.of({
        Greet: ({ payload }) =>
          counters(`greetings-${payload.name}`)
            .Increment({ amount: 1 })
            .pipe(
              Effect.map((n) => `hello ${payload.name} #${n}`),
              Effect.orDie,
            ),
      });
    });
  }).pipe(Effect.provide(Default)),
) {}
