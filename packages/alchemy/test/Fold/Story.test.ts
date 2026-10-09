import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  Aggregate,
  Command,
  Domain,
  Event,
  Policy,
  Port,
  Rejection,
  Story,
  View,
} from "@/Fold/index.ts";

// A tiny counter domain exercising every concept the story runner supports.
class Incremented extends Event.make("Incremented", {
  data: { by: Schema.Number, total: Schema.Number },
}) {}
class Capped extends Event.make("Capped") {}
class TooBig extends Rejection.make("TooBig", { data: { max: Schema.Number } }) {}
class Increment extends Command.make("Increment", {
  input: { by: Schema.Number },
  rejects: [TooBig],
  reply: { total: Schema.Number },
}) {}
class Cap extends Command.make("Cap") {}

class Counter extends Aggregate.make("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number, capped: Schema.Boolean }),
  initial: { total: 0, capped: false },
  commands: [Increment, Cap],
  events: [Incremented, Capped],
  decide: {
    Increment: (s, cmd) =>
      cmd.by > 10
        ? new TooBig({ max: 10 })
        : [new Incremented({ by: cmd.by, total: s.total + cmd.by })],
    Cap: (s) => (s.capped ? [] : [new Capped()]),
  },
  evolve: {
    Incremented: (s, e) => ({ ...s, total: e.total }),
    Capped: (s) => ({ ...s, capped: true }),
  },
  reply: {
    Increment: (s) => ({ total: s.total }),
  },
}) {}

class Totals extends View.make("Totals", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: {
    Incremented: (_, e) => ({ total: e.total }),
  },
}) {}

class Logged extends Event.make("Logged", { data: { by: Schema.Number } }) {}

// A view without state that maps events.
class History extends View.make("History", {
  from: [Counter],
  key: Counter,
  events: [Logged],
  emit: { Incremented: (e) => new Logged({ by: e.by }) },
}) {}

// Moves between counters exercise named routes, view-to-view state and a
// policy listening to a view.
class Moved extends Event.make("Moved", {
  data: { from: Schema.String, to: Schema.String, amount: Schema.Number },
}) {}
class MakeMove extends Command.make("MakeMove", {
  input: { from: Schema.String, to: Schema.String, amount: Schema.Number },
}) {}
class Move extends Aggregate.make("Move", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [MakeMove],
  events: [Moved],
  decide: { MakeMove: (_, { from, to, amount }) => [new Moved({ from, to, amount })] },
  evolve: { Moved: (s) => s },
}) {}

class Flowed extends Event.make("Flowed", {
  data: { direction: Schema.Literals(["in", "out"]), amount: Schema.Number },
}) {}

class Flows extends View.make("Flows", {
  from: [Move],
  key: Counter,
  keyOf: {
    Moved: {
      out: ({ event }) => Counter.ref(event.from),
      in: ({ event }) => Counter.ref(event.to),
    },
  },
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  evolve: {
    Moved: {
      out: (s, e) => ({ balance: s.balance - e.amount }),
      in: (s, e) => ({ balance: s.balance + e.amount }),
    },
  },
  events: [Flowed],
  emit: {
    Moved: {
      out: (e) => new Flowed({ direction: "out", amount: e.amount }),
      in: (e) => new Flowed({ direction: "in", amount: e.amount }),
    },
  },
}) {}

// Consumes Flows' events with Flows' state after each.
class Rich extends View.make("Rich", {
  from: [Flows],
  key: Counter,
  state: Schema.Struct({ rich: Schema.Boolean }),
  initial: { rich: false },
  evolve: { Flows: (_, __, { state }) => ({ rich: (state?.balance ?? 0) >= 100 }) },
}) {}

class CapWhenOverdrawn extends Policy.make("CapWhenOverdrawn", { from: Flows, on: [Flowed] }) {}
const CapWhenOverdrawnLive = CapWhenOverdrawn.toLayer(
  Effect.gen(function* () {
    const counters = yield* Counter;
    return Effect.fn(function* ({ source, state }) {
      if (state && state.balance < 0) yield* counters.send(source, new Cap());
    });
  }),
);

class Approval extends Port.make("Approval", {
  check: { args: { total: Schema.Number }, success: { ok: Schema.Boolean } },
}) {}

class CapWhenLarge extends Policy.make("CapWhenLarge", { from: Counter, on: [Incremented] }) {}
const CapWhenLargeLive = CapWhenLarge.toLayer(
  Effect.gen(function* () {
    const approval = yield* Approval;
    const counters = yield* Counter;
    return Effect.fn(function* ({ source, event }) {
      if (event.total < 15) return;
      const { ok } = yield* approval.check({ total: event.total });
      if (ok) yield* counters.send(source, new Cap());
    });
  }),
);

class Counters extends Domain.make("Counters", {
  aggregates: [Counter, Move],
  views: [Totals, History, Flows, Rich],
  policies: [CapWhenLarge, CapWhenOverdrawn],
}) {}

const story = Story.make(Counters, {
  layer: Layer.mergeAll(CapWhenLargeLive, CapWhenOverdrawnLive),
  ports: [Approval],
});
const c1 = Counter.ref("c-1");
const c2 = Counter.ref("c-2");
const m1 = Move.ref("m-1");

describe("Fold Story", () => {
  it.effect("decides, evolves, replies and projects", () =>
    story(
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.when(c1, new Increment({ by: 3 })),
      Story.then(c1, new Incremented({ by: 3, total: 5 })),
      Story.replied({ total: 5 }),
      Story.view(Totals, c1, { total: 5 }),
      Story.emitted(History, c1, [{ by: 2 }, { by: 3 }]),
    ),
  );

  it.effect("asserts rejections", () =>
    story(
      Story.when(c1, new Increment({ by: 11 })),
      Story.rejected(new TooBig({ max: 10 })),
      Story.then(c1),
    ),
  );

  it.effect("suspends a policy on a Port call until it is resolved", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 6 })),
      Story.expectCall(Approval.check, { total: 16 }),
      Story.then(c1, new Incremented({ by: 6, total: 16 })),
      Story.resolve(Approval.check, { ok: true }),
      Story.then(c1, new Capped()),
      Story.state(c1, (s) => expect(s.capped).toBe(true)),
    ),
  );

  it.effect("fails on an unasserted rejection", () =>
    story(Story.when(c1, new Increment({ by: 99 }))).pipe(
      Effect.flip,
      Effect.map((failure) => expect(String((failure as any).message)).toContain("TooBig")),
    ),
  );

  it.effect("fails on an unresolved Port call", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 9 })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain("unresolved Port calls"),
      ),
    ),
  );

  it.effect("routes one event to two keys, each with its own handlers", () =>
    story(
      Story.when(m1, new MakeMove({ from: "c-1", to: "c-2", amount: 30 })),
      Story.then(m1, new Moved({ from: "c-1", to: "c-2", amount: 30 })),
      Story.view(Flows, c1, { balance: -30 }),
      Story.view(Flows, c2, { balance: 30 }),
      Story.emitted(Flows, c1, [{ direction: "out", amount: 30 }]),
      Story.emitted(Flows, c2, (entries) => {
        expect(entries.map((e) => e.event.direction)).toEqual(["in"]);
        expect(entries[0]!.state).toEqual({ balance: 30 });
      }),
      // A policy listening to a view receives the view's state.
      Story.then(c1, new Capped()),
      Story.then(c2),
    ),
  );

  it.effect("a view consumes another view's events with its state", () =>
    story(
      Story.given(m1, new Moved({ from: "c-1", to: "c-2", amount: 120 })),
      Story.view(Rich, c2, { rich: true }),
      Story.view(Rich, c1, { rich: false }),
    ),
  );

  it.effect("history reaches views but never policies", () =>
    story(
      Story.given(m1, new Moved({ from: "c-1", to: "c-2", amount: 30 })),
      Story.view(Flows, c1, { balance: -30 }),
      Story.then(c1),
    ),
  );
});
