import * as Domain from "@alchemy.run/domain";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// A tagged union's own helpers: `guards`, `isAnyOf`, `match` and `matchOrElse`.
const Status = Schema.TaggedUnion({
  Open: {},
  Held: { by: Schema.String },
  Closed: { at: Schema.String },
});

export class Closed extends Domain.Event("Closed", { at: Schema.String }) {}
export class HeldBack extends Domain.Event("HeldBack", { by: Schema.String }) {}

const input = { target: Schema.String, at: Schema.String };
export class CloseByGuard extends Domain.Command("CloseByGuard", { input, events: [Closed] }) {}
export class CloseByTag extends Domain.Command("CloseByTag", { input, events: [Closed] }) {}
export class CloseByAnyOf extends Domain.Command("CloseByAnyOf", { input, events: [Closed] }) {}
export class CloseByMatch extends Domain.Command("CloseByMatch", { input, events: [Closed] }) {}
export class CloseByOrElse extends Domain.Command("CloseByOrElse", { input, events: [Closed] }) {}
export class Reopen extends Domain.Command("Reopen", { input, events: [HeldBack] }) {}

const closed = (at: string) => [new Closed({ at })];

export class Gate extends Domain.Aggregate("Gate", {
  id: Schema.String,
  state: Schema.Struct({ status: Status }),
  initial: { status: { _tag: "Open" } as const },
  commands: [CloseByGuard, CloseByTag, CloseByAnyOf, CloseByMatch, CloseByOrElse, Reopen],
  keyOf: (command) => command.target,
  decide: {
    CloseByGuard: (gate, c) => (Status.guards.Open(gate.status) ? closed(c.at) : []),
    CloseByTag: (gate, c) => (Predicate.isTagged(gate.status, "Open") ? closed(c.at) : []),
    CloseByAnyOf: (gate, c) => (Status.isAnyOf(["Open", "Held"])(gate.status) ? closed(c.at) : []),
    CloseByMatch: (gate, c) =>
      Status.match(gate.status, {
        Open: () => closed(c.at),
        Held: (held) => closed(held.by),
        Closed: () => [],
      }),
    CloseByOrElse: (gate, c) =>
      Status.matchOrElse(gate.status, { Open: () => closed(c.at) }, () => []),
    // Holds a gate back whatever it is: a closed one too, which the rule forbids.
    Reopen: (gate, c) => (Status.guards.Closed(gate.status) ? [new HeldBack({ by: c.at })] : []),
  },
  events: [Closed, HeldBack],
  evolve: {
    Closed: (_gate, e) => ({ status: { _tag: "Closed" as const, at: e.at } }),
    HeldBack: (_gate, e) => ({ status: { _tag: "Held" as const, by: e.by } }),
  },
  transitions: {
    ClosedStaysClosed: ({ before, after }) =>
      before.status._tag !== "Closed" || after.status._tag === "Closed",
  },
}) {}
