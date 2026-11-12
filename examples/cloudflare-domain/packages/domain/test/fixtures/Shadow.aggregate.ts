import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** An event with the aggregate's name, declared above it. */
export class ShadowEvent extends Domain.Event("Shadow", { n: Schema.Int }) {}

export class Set extends Domain.Command("Set", {
  target: Schema.String,
  input: { n: Schema.Int },
  events: [ShadowEvent],
}) {}

export class Shadow extends Domain.Aggregate("Shadow", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Int }),
  initial: { n: 0 },
  invariants: { NotNegative: (shadow) => shadow.n >= 0 },
  commands: [Set],
  decide: { Set: (_, cmd) => [new ShadowEvent({ n: cmd.n })] },
  evolve: { Shadow: (_, event) => ({ n: event.n }) },
}) {}
