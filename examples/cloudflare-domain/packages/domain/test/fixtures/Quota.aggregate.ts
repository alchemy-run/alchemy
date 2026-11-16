import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Unlimited extends Domain.Event("Unlimited", {}) {}

export class Use extends Domain.Command("Use", {
  target: Schema.String,
  input: {},
  events: [Unlimited],
}) {}

/**
 * A quota with no limit written is open to anything, which `NeverOpen` says
 * never happens: a state without the optional `limit` breaks it.
 */
export class Quota extends Domain.Aggregate("Quota", {
  id: Schema.String,
  state: Schema.Struct({ limit: Schema.optionalKey(Schema.Int), open: Schema.Boolean }),
  initial: { open: false },
  invariants: { NeverOpen: (quota) => !quota.open },
  commands: [Use],
  decide: {
    Use: (state) => (state.limit === undefined ? [new Unlimited({})] : []),
  },
  evolve: {
    Unlimited: (state) => ({ ...state, open: true }),
  },
}) {}
