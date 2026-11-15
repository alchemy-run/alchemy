/**
 * Type-level regressions for `Domain.Decision`: what `record` accepts, which
 * commands a decision and an aggregate may implement, and one implementation
 * per command in a model. Compiled, never run.
 */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class Opened extends Domain.Event("Opened") {}
class Closed extends Domain.Event("Closed") {}
class Painted extends Domain.Event("Painted", { color: Schema.String }) {}
class Stuck extends Domain.Rejection("Stuck") {}

class Open extends Domain.Command("Open", { target: Schema.String, events: [Opened] }) {}
class OpenGate extends Domain.Command("OpenGate", {
  target: Schema.String.pipe(Schema.brand("GateId")),
  input: { limit: Schema.Int },
  events: [Opened],
}) {}
class OpenBoth extends Domain.Command("OpenBoth", {
  input: { left: Schema.String, right: Schema.String },
  events: [Opened, Painted],
  rejects: [Stuck],
  reply: { open: Schema.Number },
}) {}
class CloseBoth extends Domain.Command("CloseBoth", {
  input: { left: Schema.String, right: Schema.String },
  events: [Closed],
}) {}

/** Decides one command itself, and folds what decisions record on it. */
class Door extends Domain.Aggregate("Door", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [Open],
  events: [Closed, Painted],
  decide: { Open: () => [Opened.make()] },
  evolve: {
    Opened: () => ({ open: true }),
    Closed: () => ({ open: false }),
    Painted: (door) => door,
  },
}) {}

/** Only folds. */
class Window extends Domain.Aggregate("Window", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  events: [Opened],
  evolve: { Opened: () => ({ open: true }) },
}) {}

class Both extends Domain.Decision(OpenBoth, {
  reads: (cmd) => ({ left: Door.ref(cmd.left), right: Window.ref(cmd.right) }),
  decide: ({ left, right }, cmd) =>
    left.state.open
      ? Stuck.make()
      : [
          left.record(Painted.make({ color: cmd.left })),
          right.record(Opened.make()),
          // @ts-expect-error a Window does not fold Painted
          right.record(Painted.make({ color: "red" })),
        ],
  reply: ({ left, right }) => ({ open: Number(left.open) + Number(right.open) }),
}) {}

class Shut extends Domain.Decision(CloseBoth, {
  reads: (cmd) => ({ left: Door.ref(cmd.left), right: Door.ref(cmd.right) }),
  decide: Effect.fn(function* ({ left, right }) {
    return [left.record(Closed.make()), right.record(Closed.make())];
  }),
}) {}

// A command with a target belongs to an aggregate.
// @ts-expect-error Open has a target: an aggregate implements it
class Wrong extends Domain.Decision(Open, {
  reads: () => ({}),
  decide: () => [],
}) {}

// A command without a target belongs to a decision.
class Shed extends Domain.Aggregate("Shed", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  // @ts-expect-error CloseBoth has no target: implement it with a Domain.Decision
  commands: [CloseBoth],
  decide: { CloseBoth: () => [Closed.make()] },
  evolve: { Closed: (shed) => shed },
}) {}

// An aggregate with a command decides it.
// @ts-expect-error Property 'decide' is missing
class Undecided extends Domain.Aggregate("Undecided", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Open],
  evolve: { Opened: (state) => state },
}) {}

/** Its own command's handlers stay typed next to events decisions record. */
class Gate extends Domain.Aggregate("Gate", {
  id: Schema.String.pipe(Schema.brand("GateId")),
  state: Schema.Struct({ opened: Schema.Int }),
  initial: { opened: 0 },
  commands: [OpenGate],
  events: [Painted],
  decide: {
    OpenGate: (gate, cmd) => (gate.opened > cmd.limit ? [] : [Opened.make()]),
  },
  evolve: {
    Opened: (gate) => ({ opened: gate.opened + 1 }),
    Painted: (gate, e) => ({ opened: gate.opened + e.color.length }),
  },
}) {}

class BothAgain extends Domain.Decision(OpenBoth, {
  reads: (cmd) => ({ left: Door.ref(cmd.left) }),
  decide: ({ left }) => [left.record(Painted.make({ color: "blue" }))],
  reply: () => ({ open: 0 }),
}) {}

export class House extends Domain.Model("House", {
  aggregates: [Door, Window],
  decisions: [Both, Shut],
}) {}

export class Twice extends Domain.Model("Twice", {
  aggregates: [Door, Window],
  // @ts-expect-error OpenBoth is already implemented by another decision
  decisions: [Both, BothAgain],
}) {}

export const program = Effect.gen(function* () {
  const doors = yield* Door;
  yield* doors.send("d-1", Open.make());
  const both = yield* Both;
  const receipt = yield* both.send(OpenBoth.make({ left: "d-1", right: "w-1" }));
  const open: number = receipt.reply.open;
  const shut = yield* Shut;
  // @ts-expect-error the command a decision implements, and no other
  yield* shut.send(OpenBoth.make({ left: "d-1", right: "w-1" }));
  return [open, Wrong, Shed, Undecided, Gate] as const;
});
