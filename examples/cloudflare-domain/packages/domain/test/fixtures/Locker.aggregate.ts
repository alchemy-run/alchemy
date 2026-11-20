import * as Domain from "@alchemy.run/domain";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

const Amount = Schema.Int.check(Schema.isGreaterThan(0));

export class Opened extends Domain.Event("Opened", {}) {}

export class Stored extends Domain.Event("Stored", { amount: Schema.Int }) {}

export class Taken extends Domain.Event("Taken", { amount: Schema.Int }) {}

export class Sealed extends Domain.Event("Sealed", {}) {}

export class NotOpen extends Domain.Rejection("NotOpen") {}

export class NotEnough extends Domain.Rejection("NotEnough") {}

export class Open extends Domain.Command("Open", {
  input: { id: Schema.String },
  events: [Opened],
  rejects: [NotOpen],
}) {}

export class Store extends Domain.Command("Store", {
  input: { id: Schema.String, amount: Amount },
  events: [Stored],
  rejects: [NotOpen],
}) {}

export class Take extends Domain.Command("Take", {
  input: { id: Schema.String, amount: Amount },
  events: [Taken],
  rejects: [NotOpen, NotEnough],
}) {}

export class Grab extends Domain.Command("Grab", {
  input: { id: Schema.String, amount: Amount },
  events: [Taken],
  rejects: [NotOpen],
}) {}

export class Seal extends Domain.Command("Seal", {
  input: { id: Schema.String },
  events: [Sealed],
  rejects: [NotOpen],
}) {}

const LockerState = Schema.Union([
  Schema.TaggedStruct("New", {}),
  Schema.TaggedStruct("Open", { held: Schema.Int }),
  Schema.TaggedStruct("Sealed", { held: Schema.Int }),
]);
type LockerState = typeof LockerState.Type;

/** What a locker holds, whatever state it is in: a matcher built once and used as a function. */
const held = Match.type<LockerState>().pipe(
  Match.tag("New", () => 0),
  Match.tag("Open", "Sealed", (locker) => locker.held),
  Match.exhaustive,
);

/** A locker, with every handler and rule written with `effect/Match` in place of `_tag` tests. */
export class Locker extends Domain.Aggregate("Locker", {
  id: Schema.String,
  state: LockerState,
  initial: { _tag: "New" },
  invariants: {
    NeverNegative: (locker) => held(locker) >= 0,
  },
  transitions: {
    ASealedLockerKeepsWhatItHolds: ({ before, after }) =>
      Match.value(before).pipe(
        Match.tag("Sealed", (sealed) => after._tag === "Sealed" && after.held === sealed.held),
        Match.orElse(() => true),
      ),
  },
  commands: [Open, Store, Take, Grab, Seal],
  keyOf: (cmd) => cmd.id,
  decide: {
    Open: (locker) =>
      Match.value(locker).pipe(
        Match.tag("New", () => [new Opened({})]),
        Match.orElse(() => new NotOpen()),
      ),
    Store: (locker, cmd) =>
      Match.valueTags(locker, {
        New: () => new NotOpen(),
        Open: () => [new Stored({ amount: cmd.amount })],
        Sealed: () => new NotOpen(),
      }),
    // An object pattern with a predicate: an open locker that holds enough.
    Take: (locker, cmd) =>
      Match.value(locker).pipe(
        Match.when({ _tag: "Open", held: (held) => held >= cmd.amount }, () => [
          new Taken({ amount: cmd.amount }),
        ]),
        Match.tag("Open", () => new NotEnough()),
        Match.orElse(() => new NotOpen()),
      ),
    // It never asks whether the locker holds enough.
    Grab: (locker, cmd) =>
      Match.value(locker).pipe(
        Match.tag("Open", () => [new Taken({ amount: cmd.amount })]),
        Match.orElse(() => new NotOpen()),
      ),
    Seal: (locker) =>
      Match.value(locker).pipe(
        Match.not({ _tag: "Open" }, () => new NotOpen()),
        Match.orElse(() => [new Sealed({})]),
      ),
  },
  evolve: {
    Opened: () => ({ _tag: "Open" as const, held: 0 }),
    Stored: (locker, event) => ({ _tag: "Open" as const, held: held(locker) + event.amount }),
    Taken: (locker, event) => ({ _tag: "Open" as const, held: held(locker) - event.amount }),
    Sealed: (locker) =>
      Match.value(locker).pipe(
        Match.tagsExhaustive({
          New: () => ({ _tag: "Sealed" as const, held: 0 }),
          Open: (open) => ({ _tag: "Sealed" as const, held: open.held }),
          Sealed: (sealed) => sealed,
        }),
      ),
  },
}) {}
