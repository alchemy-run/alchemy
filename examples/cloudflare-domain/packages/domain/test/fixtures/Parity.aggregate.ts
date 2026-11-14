import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Taken extends Domain.Event("Taken", { amount: Schema.Int }) {}

export class Take extends Domain.Command("Take", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Taken],
}) {}

/** Decides with code the explorer does not read (`Math.trunc`), and breaks its invariant. */
export class Parity extends Domain.Aggregate("Parity", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Int }),
  initial: { n: 0 },
  invariants: { NotNegative: (parity) => parity.n >= 0 },
  commands: [Take],
  decide: {
    Take: (_, cmd) => [new Taken({ amount: Math.trunc(cmd.amount) })],
  },
  evolve: { Taken: (parity, event) => ({ n: parity.n - event.amount }) },
}) {}
