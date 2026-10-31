/** A second class on the counter's pool, which calls the counter itself. */
import * as Rivet from "@alchemy.run/rivet";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Cluster, Default } from "./cluster.ts";
import Counter from "./counter.ts";

export default class Greeter extends Rivet.DurableObject<Greeter>()(
  "Greeter",
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Rivet.Client(Counter);
    return Effect.gen(function* () {
      return {
        greet: (name: string): Effect.Effect<string, never, RuntimeContext> =>
          Effect.gen(function* () {
            const count = yield* counters.getByName(`greetings-${name}`).increment();
            return `hello ${name} #${count}`;
          }),
      };
    });
  }).pipe(Effect.provide(Layer.mergeAll(Default, Cluster))),
) {}
