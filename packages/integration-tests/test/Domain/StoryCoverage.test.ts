import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A door that opens and closes; closing it locks it through an external system.
class Opened extends Domain.Event("Opened") {}
class Closed extends Domain.Event("Closed") {}
class AlreadyOpen extends Domain.Rejection("AlreadyOpen") {}
class NotOpen extends Domain.Rejection("NotOpen") {}
class Open extends Domain.Command("Open", {
  target: Schema.String,
  events: [Opened],
  rejects: [AlreadyOpen],
}) {}
class Close extends Domain.Command("Close", {
  target: Schema.String,
  events: [Closed],
  rejects: [NotOpen],
}) {}
class Door extends Domain.Aggregate("Door", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [Open, Close],
  decide: {
    Open: (s) => (s.open ? new AlreadyOpen() : [new Opened()]),
    Close: (s) => (s.open ? [new Closed()] : new NotOpen()),
  },
  evolve: {
    Opened: () => ({ open: true }),
    Closed: () => ({ open: false }),
  },
}) {}

class Locks extends Domain.ExternalSystem("Locks", {
  lock: { args: { door: Schema.String }, success: { locked: Schema.Boolean } },
  unlock: { args: { door: Schema.String }, success: { locked: Schema.Boolean } },
}) {}

class LockOnClose extends Domain.Policy("LockOnClose", { from: Door, on: [Closed] }) {}
const LockOnCloseLive = LockOnClose.toLayer(
  Effect.gen(function* () {
    const locks = yield* Locks;
    return Effect.fn(function* ({ source }) {
      yield* locks.lock({ door: source.id });
    });
  }),
);

class DoorState extends Domain.View("DoorState", {
  from: [Door],
  key: Door,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  evolve: { Opened: () => ({ open: true }), Closed: () => ({ open: false }) },
}) {}

class Doors extends Domain.Model("Doors", {
  aggregates: [Door],
  views: [DoorState],
  policies: [LockOnClose],
}) {}

const story = Story.make(Doors, { layer: LockOnCloseLive, stub: [Locks] });
const d1 = Door.ref("d-1");

describe("Domain Story coverage", () => {
  it.effect("lists what no story ran", () =>
    Effect.gen(function* () {
      const coverage = Story.coverage(Doors);
      // External system ops join the list once a story stubs or calls the system.
      expect(coverage.missing()).toEqual([
        "command Open",
        "rejection Open/AlreadyOpen",
        "command Close",
        "rejection Close/NotOpen",
        "reaction LockOnClose/Closed",
        "view DoorState",
      ]);

      yield* story(
        Story.when(d1, new Open()),
        Story.then(d1, new Opened()),
        Story.when(d1, new Open()),
        Story.rejected(new AlreadyOpen()),
      );
      yield* story(
        Story.given(d1, new Opened()),
        Story.when(d1, new Close()),
        Story.then(d1, new Closed()),
        Story.call(Locks.lock, { door: "d-1" }),
        Story.succeed(Locks.lock, { locked: true }),
      );
      // A failed story still counts what it ran.
      yield* story(Story.when(d1, new Close())).pipe(Effect.flip);

      expect(coverage.missing()).toEqual(["call Locks.unlock"]);
      expect(coverage.covered()).toEqual([
        "command Open",
        "view DoorState",
        "rejection Open/AlreadyOpen",
        "call Locks.lock",
        "command Close",
        "reaction LockOnClose/Closed",
        "rejection Close/NotOpen",
      ]);
    }),
  );
});
