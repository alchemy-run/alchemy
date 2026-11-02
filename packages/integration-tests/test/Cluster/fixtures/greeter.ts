/** A second entity on the same runners, declared as a tag and implemented as a Layer. */
import * as Cluster from "@alchemy.run/cluster";
import * as Effect from "effect/Effect";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Default } from "./cluster.ts";
import Counters from "./counter.ts";

export class GreeterRpcs extends RpcGroup.make(
  Rpc.make("Greet", { payload: { name: Schema.String }, success: Schema.String }),
) {}

export class Greeters extends Cluster.Entity<Greeters>()("Greeter", { schema: GreeterRpcs }) {}

// The greeter calls the counter itself, by name.
export default Greeters.make(
  { main: import.meta.url, runners: Default },
  Effect.gen(function* () {
    const counters = yield* Counters;
    return Effect.gen(function* () {
      return {
        Greet: ({ payload }) =>
          counters(`greetings-${payload.name}`)
            .Increment({ amount: 1 })
            .pipe(
              Effect.map((n) => `hello ${payload.name} #${n}`),
              Effect.orDie,
            ),
      };
    });
  }),
);
