import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Moved extends Domain.Event("Moved", { by: Schema.Int }) {}

export class Advance extends Domain.Command("Advance", {
  input: { id: Schema.String },
  events: [Moved],
}) {}

export class Nudge extends Domain.Command("Nudge", {
  input: { id: Schema.String },
  events: [Moved],
}) {}

/** Its place is a multiple of five. Advance moves it by five, and Nudge by one. */
export class Stride extends Domain.Aggregate("Stride", {
  id: Schema.String,
  state: Schema.Struct({ place: Schema.Int.check(Schema.isMultipleOf(5)) }),
  initial: { place: 0 },
  invariants: { NeverBehind: (stride) => stride.place >= 0 },
  commands: [Advance, Nudge],
  keyOf: (cmd) => cmd.id,
  decide: {
    Advance: () => [new Moved({ by: 5 })],
    Nudge: () => [new Moved({ by: 1 })],
  },
  evolve: {
    Moved: (state, event) => ({ ...state, place: state.place + event.by }),
  },
}) {}
