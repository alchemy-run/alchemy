import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Counted extends Domain.Event("Counted", { n: Schema.Int }) {}

export class Count extends Domain.Command("Count", {
  target: Schema.String,
  input: { n: Schema.Int },
  events: [Counted],
}) {}

/** Invariants written aside from the definition, where the prover does not look. */
const invariants = { NotNegative: (aside: { readonly n: number }) => aside.n >= 0 };

export class Aside extends Domain.Aggregate("Aside", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Int }),
  initial: { n: 0 },
  invariants,
  commands: [Count],
  decide: { Count: (_, cmd) => [new Counted({ n: cmd.n })] },
  evolve: { Counted: (_, event) => ({ n: event.n }) },
}) {}
