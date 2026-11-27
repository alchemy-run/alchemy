/**
 * A declaration given a thunk has the type it has given its props
 * directly. Type-checked only.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_: T) => _;

class Opened extends Domain.Event("Opened", { subject: Schema.String }) {}
class Logged extends Domain.Event("Logged", { line: Schema.String }) {}
class Open extends Domain.Command("Open", {
  input: { doorId: Schema.String, subject: Schema.String },
  events: [Opened],
}) {}
class OpenBoth extends Domain.Command("OpenBoth", {
  input: { left: Schema.String, right: Schema.String },
  events: [Opened],
}) {}

const door = {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [Open],
  keyOf: (command: Open) => command.doorId,
  decide: { Open: (_: unknown, command: Open) => [new Opened({ subject: command.subject })] },
  evolve: { Opened: () => ({ open: true }) },
} as const;

// ---------------------------------------------------------------- Aggregate
class Door extends Domain.Aggregate("Door", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [Open],
  keyOf: (command) => command.doorId,
  decide: { Open: (_, command) => [new Opened({ subject: command.subject })] },
  evolve: { Opened: () => ({ open: true }) },
}) {}
class LazyDoor extends Domain.Aggregate("Door", () => ({
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [Open],
  keyOf: (command) => command.doorId,
  decide: { Open: (_, command) => [new Opened({ subject: command.subject })] },
  evolve: { Opened: () => ({ open: true }) },
})) {}
assert<Equals<Domain.Aggregate.StateOf<typeof Door>, Domain.Aggregate.StateOf<typeof LazyDoor>>>(
  true,
);
assert<Equals<(typeof Door)["definition"], (typeof LazyDoor)["definition"]>>(true);
void door;

// ---------------------------------------------------------------- View
class Times extends Domain.View("Times", {
  from: [Door],
  key: Door,
  state: Schema.Struct({ opened: Schema.Number }),
  initial: { opened: 0 },
  evolve: { Opened: (state) => ({ opened: state.opened + 1 }) },
}) {}
class LazyTimes extends Domain.View("Times", () => ({
  from: [Door],
  key: Door,
  state: Schema.Struct({ opened: Schema.Number }),
  initial: { opened: 0 },
  evolve: { Opened: (state) => ({ opened: state.opened + 1 }) },
})) {}
assert<Equals<(typeof Times)["definition"], (typeof LazyTimes)["definition"]>>(true);
assert<Equals<Domain.View.StateOf<typeof Times>, Domain.View.StateOf<typeof LazyTimes>>>(true);

// ---------------------------------------------------------------- Stream
class Log extends Domain.Stream("Log", { key: Door, entries: [Logged] }) {}
class LazyLog extends Domain.Stream("Log", () => ({ key: Door, entries: [Logged] })) {}
assert<Equals<(typeof Log)["definition"], (typeof LazyLog)["definition"]>>(true);

// ---------------------------------------------------------------- Projection
class Logger extends Domain.Projection("Logger", {
  from: [Door],
  key: Door,
  on: [Opened],
  writes: [Log],
}) {}
class LazyLogger extends Domain.Projection("Logger", () => ({
  from: [Door],
  key: Door,
  on: [Opened],
  writes: [Log],
})) {}
assert<Equals<(typeof Logger)["definition"], (typeof LazyLogger)["definition"]>>(true);

// ---------------------------------------------------------------- Policy
class AutoClose extends Domain.Policy("AutoClose", { from: Door, on: [Opened] }) {}
class LazyAutoClose extends Domain.Policy("AutoClose", () => ({ from: Door, on: [Opened] })) {}
assert<Equals<(typeof AutoClose)["definition"], (typeof LazyAutoClose)["definition"]>>(true);

// ---------------------------------------------------------------- Query
class Recent extends Domain.Query("Recent", {
  input: { doorId: Schema.String },
  success: Schema.Number,
  waitsFor: [Logger],
}) {}
class LazyRecent extends Domain.Query("Recent", () => ({
  input: { doorId: Schema.String },
  success: Schema.Number,
  waitsFor: [Logger],
})) {}
assert<Equals<(typeof Recent)["definition"], (typeof LazyRecent)["definition"]>>(true);

// ---------------------------------------------------------------- Saga
class Visit extends Domain.Saga("Visit", {
  key: Schema.String,
  input: { guest: Schema.String },
  result: { welcomed: Schema.Boolean },
}) {}
class LazyVisit extends Domain.Saga("Visit", () => ({
  key: Schema.String,
  input: { guest: Schema.String },
  result: { welcomed: Schema.Boolean },
})) {}
assert<Equals<(typeof Visit)["definition"], (typeof LazyVisit)["definition"]>>(true);

// ---------------------------------------------------------------- Decision
class Both extends Domain.Decision(OpenBoth, {
  reads: { left: Door, right: Door },
  keyOf: (command) => ({ left: command.left, right: command.right }),
  decide: ({ left, right }) => [
    left.record(new Opened({ subject: "both" })),
    right.record(new Opened({ subject: "both" })),
  ],
}) {}
class LazyBoth extends Domain.Decision(OpenBoth, () => ({
  reads: { left: Door, right: Door },
  keyOf: (command) => ({ left: command.left, right: command.right }),
  decide: ({ left, right }) => [
    left.record(new Opened({ subject: "both" })),
    right.record(new Opened({ subject: "both" })),
  ],
})) {}
assert<Equals<(typeof Both)["reads"], (typeof LazyBoth)["reads"]>>(true);

// ---------------------------------------------------------------- Model and Api
class House extends Domain.Model("House", {
  aggregates: [Door],
  views: [Times],
  streams: [Log],
  projections: [Logger],
  policies: [AutoClose],
  queries: [Recent],
  decisions: [Both],
}) {}
class LazyHouse extends Domain.Model("House", () => ({
  aggregates: [Door],
  views: [Times],
  streams: [Log],
  projections: [Logger],
  policies: [AutoClose],
  queries: [Recent],
  decisions: [Both],
})) {}
assert<Equals<(typeof House)["commands"], (typeof LazyHouse)["commands"]>>(true);
assert<Equals<(typeof House)["views"], (typeof LazyHouse)["views"]>>(true);
assert<Equals<Parameters<(typeof House)["layer"]>, Parameters<(typeof LazyHouse)["layer"]>>>(true);
// The model's mentions are there either way.
LazyHouse.Open;
LazyHouse.Door;
LazyHouse.Times;

class HouseApi extends Domain.Api("HouseApi", {
  model: House,
  commands: ["Open"],
  views: ["Times"],
}) {}
class LazyHouseApi extends Domain.Api("HouseApi", () => ({
  model: House,
  commands: ["Open"],
  views: ["Times"],
})) {}
assert<Equals<Domain.Api.ClientOf<typeof HouseApi>, Domain.Api.ClientOf<typeof LazyHouseApi>>>(
  true,
);
// @ts-expect-error the Api serves only the commands it lists
Domain.Api("Nope", () => ({ model: House, commands: ["Close"] }));

// ---------------------------------------------------------------- what stays direct

// Events, commands, rejections and rewrites are schema classes: the class is
// the schema, made from its fields when it is declared, so they take their
// props directly. A field that refers back to its own class is a
// `Schema.suspend`.
// @ts-expect-error an event's fields are never a thunk
Domain.Event("Late", () => ({ at: Schema.Number }));
