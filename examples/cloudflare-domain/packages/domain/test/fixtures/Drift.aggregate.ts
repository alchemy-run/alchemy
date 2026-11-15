import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Exact extends Domain.Event("Exact", {}) {}

export class Rounded extends Domain.Event("Rounded", {}) {}

export class Add extends Domain.Command("Add", {
  target: Schema.String,
  input: { a: Schema.Number, b: Schema.Number },
  events: [Exact, Rounded],
}) {}

/**
 * In arithmetic a tenth and two tenths make three tenths. In JavaScript they
 * make `0.30000000000000004`, so the sum is never exact and `NeverRounded`
 * is false of the real code, whatever a solver that counts exactly says.
 */
export class Drift extends Domain.Aggregate("Drift", {
  id: Schema.String,
  state: Schema.Struct({ rounded: Schema.Boolean }),
  initial: { rounded: false },
  invariants: { NeverRounded: (drift) => !drift.rounded },
  commands: [Add],
  decide: {
    Add: (_, command) =>
      command.a === 0.1 && command.b === 0.2
        ? command.a + command.b === 0.3
          ? [new Exact({})]
          : [new Rounded({})]
        : [],
  },
  evolve: {
    Exact: (drift) => drift,
    Rounded: () => ({ rounded: true }),
  },
}) {}
