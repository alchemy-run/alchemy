import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Code = Schema.String.check(Schema.isPattern(/^[A-Z]+$/));

export class Renamed extends Domain.Event("Renamed", { code: Schema.String }) {}

export class Counted extends Domain.Event("Counted", {}) {}

export class Rename extends Domain.Command("Rename", {
  target: Schema.String,
  input: { code: Schema.String },
  events: [Renamed],
}) {}

export class Count extends Domain.Command("Count", {
  target: Schema.String,
  input: {},
  events: [Counted],
}) {}

/** Its code is capital letters, and Rename writes any text as the code. */
export class Label extends Domain.Aggregate("Label", {
  id: Schema.String,
  state: Schema.Struct({ code: Code, uses: Schema.Int }),
  initial: { code: "A", uses: 0 },
  invariants: { NeverUnused: (label) => label.uses >= 0 },
  commands: [Rename, Count],
  decide: {
    Rename: (_state, command) => [new Renamed({ code: command.code })],
    Count: () => [new Counted({})],
  },
  evolve: {
    Renamed: (state, event) => ({ ...state, code: event.code }),
    Counted: (state) => ({ ...state, uses: state.uses + 1 }),
  },
}) {}
