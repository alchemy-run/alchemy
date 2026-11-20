/** RivetKit's Effect form (`@rivetkit/effect`): the Actor's implementation and the program that serves it, deployed unchanged. */
import { NodeRuntime } from "@effect/platform-node";
import { Client, Registry, State } from "@rivetkit/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Counter } from "./api.ts";

const CounterLive = Counter.toLayer(
  Effect.fnUntraced(function* ({ state }) {
    return Counter.of({
      Add: Effect.fnUntraced(function* ({ payload }) {
        const updated = yield* State.updateAndGet(state, (s) => ({
          count: s.count + payload.amount,
        })).pipe(Effect.orDie);
        return updated.count;
      }),
      Read: () =>
        State.get(state).pipe(
          Effect.map((s) => s.count),
          Effect.orDie,
        ),
    });
  }),
  {
    state: {
      schema: Schema.Struct({ count: Schema.Number }),
      initialValue: () => ({ count: 0 }),
    },
    name: "Counter",
  },
);

const ActorLayer = CounterLive.pipe(
  Layer.provide(Client.layer({ endpoint: process.env.RIVET_ENDPOINT! })),
);

Layer.launch(Registry.serve(ActorLayer).pipe(Layer.provide(Registry.layer()))).pipe(
  NodeRuntime.runMain,
);
