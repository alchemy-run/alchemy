import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class Passed extends Domain.Event("Passed", { chain: Schema.String, left: Schema.Number }) {}

export class Pass extends Domain.Command("Pass", {
  input: { id: Schema.String, chain: Schema.String, left: Schema.Number },
  events: [Passed],
}) {}

/** One hop of a relay: `<chain>-<left>`. */
export class Hop extends Domain.Aggregate("Hop", {
  id: Schema.String,
  state: Schema.Struct({ passed: Schema.Boolean }),
  initial: { passed: false },
  commands: [Pass],
  keyOf: (command) => command.id,
  decide: { Pass: (_, { chain, left }) => [new Passed({ chain, left })] },
  evolve: { Passed: () => ({ passed: true }) },
}) {}

/** Pass the baton to the next hop until none are left. */
export class PassOn extends Domain.Policy("PassOn", { from: Hop, on: [Passed] }) {}
export const PassOnLive = PassOn.toLayer(
  Effect.gen(function* () {
    const hops = yield* Hop;
    return Effect.fn(function* ({ event }) {
      if (event.left === 0) return;
      const left = event.left - 1;
      yield* hops.send(new Pass({ id: `${event.chain}-${left}`, chain: event.chain, left }));
    });
  }),
);

export class Relay extends Domain.Model("Relay", {
  aggregates: [Hop],
  policies: [PassOn],
}) {}
