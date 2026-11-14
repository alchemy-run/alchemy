import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Never extends Domain.Rejection("Never") {}

export class Went extends Domain.Event("Went", {}) {}

export class Go extends Domain.Command("Go", {
  target: Schema.String,
  input: {},
  events: [Went],
  rejects: [Never],
}) {}

/** Its only command is always rejected, so nothing ever happens to it. */
export class Deny extends Domain.Aggregate("Deny", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Int }),
  initial: { n: 0 },
  invariants: { NotNegative: (deny) => deny.n >= 0 },
  commands: [Go],
  decide: { Go: () => new Never() },
  evolve: { Went: (deny) => ({ n: deny.n - 1 }) },
}) {}
