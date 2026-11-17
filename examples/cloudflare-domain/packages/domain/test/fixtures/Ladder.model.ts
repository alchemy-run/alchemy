import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Climbed extends Domain.Event("Climbed", {}) {}

export class Rested extends Domain.Event("Rested", {}) {}

export class Climb extends Domain.Command("Climb", {
  input: { id: Schema.String },
  events: [Climbed],
}) {}

export class Rest extends Domain.Command("Rest", {
  input: { id: Schema.String },
  events: [Rested],
}) {}

export class Climber extends Domain.Aggregate("Climber", {
  id: Schema.String,
  state: Schema.Struct({ rung: Schema.Int }),
  initial: { rung: 0 },
  commands: [Climb, Rest],
  keyOf: (cmd) => cmd.id,
  decide: {
    Climb: () => [new Climbed({})],
    Rest: () => [new Rested({})],
  },
  evolve: {
    Climbed: (climber) => ({ rung: climber.rung + 1 }),
    Rested: (climber) => climber,
  },
}) {}

/** The rung the ladder ends at. */
export const TOP = 5;

/**
 * A ladder nobody is meant to reach the top of. One climb is one rung, so the
 * rule breaks only after five climbs: more commands than a search of every
 * sequence goes through.
 */
export class Ladder extends Domain.Model("Ladder", {
  aggregates: [Climber],
  invariants: {
    NobodyReachesTheTop: (ladder) => ladder.Climber.every((climber) => climber.state.rung < TOP),
  },
}) {}

export class LadderApi extends Domain.Api("LadderApi", {
  model: Ladder,
  commands: ["Climb", "Rest"],
  views: [],
  streams: [],
  queries: [],
}) {}
