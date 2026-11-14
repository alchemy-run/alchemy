import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Copied extends Domain.Event("Copied", { b: Schema.Int }) {}

export class Lowered extends Domain.Event("Lowered", {}) {}

export class Copy extends Domain.Command("Copy", {
  target: Schema.String,
  input: {},
  events: [Copied],
}) {}

export class Lower extends Domain.Command("Lower", {
  target: Schema.String,
  input: {},
  events: [Lowered],
}) {}

const NonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * `b` stays at or above zero only while `a` does, and the schema says `a`
 * does. `Lower` takes `a` below zero, so the schema's promise is false.
 */
export class Gap extends Domain.Aggregate("Gap", {
  id: Schema.String,
  state: Schema.Struct({ a: NonNegative, b: Schema.Int }),
  initial: { a: 0, b: 0 },
  invariants: { BNotNegative: (gap) => gap.b >= 0 },
  commands: [Copy, Lower],
  decide: {
    Copy: (gap) => [new Copied({ b: gap.a })],
    Lower: () => [new Lowered({})],
  },
  evolve: {
    Copied: (gap, event) => ({ a: gap.a, b: event.b }),
    Lowered: (gap) => ({ a: gap.a - 1, b: gap.b }),
  },
}) {}
