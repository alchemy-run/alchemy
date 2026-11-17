import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ChoreStarted extends Domain.Event("ChoreStarted", {}) {}

export class ChoreNudged extends Domain.Event("ChoreNudged", {}) {}

export class ChoreDropped extends Domain.Event("ChoreDropped", {}) {}

export class AlreadyStarted extends Domain.Rejection("AlreadyStarted", {}) {}

export class Start extends Domain.Command("Start", {
  input: { id: Schema.String },
  events: [ChoreStarted],
  rejects: [AlreadyStarted],
}) {}

/** Remind whoever started the chore. It stays started, and one that is not started records nothing. */
export class Nudge extends Domain.Command("Nudge", {
  input: { id: Schema.String },
  events: [ChoreNudged],
}) {}

/** Give the chore up. One that is not started records nothing. */
export class Drop extends Domain.Command("Drop", {
  input: { id: Schema.String },
  events: [ChoreDropped],
}) {}

export class Chore extends Domain.Aggregate("Chore", {
  id: Schema.String,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Started", { nudged: Schema.Boolean }),
    Schema.TaggedStruct("Dropped", {}),
  ]),
  initial: { _tag: "New" },
  commands: [Start, Nudge, Drop],
  keyOf: (cmd) => cmd.id,
  decide: {
    Start: (chore) => (chore._tag === "New" ? [new ChoreStarted({})] : new AlreadyStarted()),
    Nudge: (chore) => (chore._tag === "Started" ? [new ChoreNudged({})] : []),
    Drop: (chore) => (chore._tag === "Started" ? [new ChoreDropped({})] : []),
  },
  evolve: {
    ChoreStarted: () => ({ _tag: "Started" as const, nudged: false }),
    ChoreNudged: () => ({ _tag: "Started" as const, nudged: true }),
    ChoreDropped: () => ({ _tag: "Dropped" as const }),
  },
}) {}

/** Whenever a chore starts, nudge it in an hour. */
export class Reminder extends Domain.Policy("Reminder", {
  from: Chore,
  on: [ChoreStarted],
}) {}

export const ReminderLive = Reminder.toLayer(
  Effect.gen(function* () {
    const chores = yield* Chore;
    return Effect.fn(function* ({ source }) {
      yield* chores.schedule(new Nudge({ id: source.id }), { after: "1 hour" });
    });
  }),
);

/** Whenever a chore is nudged, drop it a day later. */
export class GiveUp extends Domain.Policy("GiveUp", {
  from: Chore,
  on: [ChoreNudged],
}) {}

export const GiveUpLive = GiveUp.toLayer(
  Effect.gen(function* () {
    const chores = yield* Chore;
    return Effect.fn(function* ({ source }) {
      yield* chores.schedule(new Drop({ id: source.id }), { after: "1 day" });
    });
  }),
);

/**
 * Chores nobody finishes. A started chore is nudged after an hour and dropped
 * a day after that, so every chore ends dropped: that is true only in the
 * end, and false at every moment before it.
 */
export class Chores extends Domain.Model("Chores", {
  aggregates: [Chore],
  policies: [Reminder, GiveUp],
  eventually: {
    EveryChoreIsDropped: (chores) => chores.Chore.every((chore) => chore.state._tag === "Dropped"),
  },
}) {}

/** The same chores, where nobody gives one up: a started chore is nudged and stays started. */
export class Lingering extends Domain.Model("Lingering", {
  aggregates: [Chore],
  policies: [Reminder],
  eventually: {
    EveryChoreIsDropped: (chores) => chores.Chore.every((chore) => chore.state._tag === "Dropped"),
  },
}) {}

export class ChoresApi extends Domain.Api("ChoresApi", {
  model: Chores,
  commands: ["Start"],
  views: [],
  streams: [],
  queries: [],
}) {}

export class LingeringApi extends Domain.Api("LingeringApi", {
  model: Lingering,
  commands: ["Start"],
  views: [],
  streams: [],
  queries: [],
}) {}
