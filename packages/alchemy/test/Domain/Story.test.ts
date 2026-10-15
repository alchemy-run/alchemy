import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Domain from "@/Domain/index.ts";
import { InMemory } from "@/Domain/InMemory.ts";
import { Story } from "@/Domain/Story.ts";

// A tiny counter domain exercising every concept the story runner supports.
class Incremented extends Domain.Event("Incremented", {
  by: Schema.Number,
  total: Schema.Number,
}) {}
class Capped extends Domain.Event("Capped") {}
class TooBig extends Domain.Rejection("TooBig", { max: Schema.Number }) {}
// Who is operating a counter: provided by middleware, read by `decide`.
class Operator extends Domain.RequestContext<Operator>()("Test/Operator", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class OperatorSession extends RpcMiddleware.Service<OperatorSession, { provides: Operator }>()(
  "Test/OperatorSession",
  { error: Unauthenticated },
) {}
const OperatorSessionLive = Layer.succeed(OperatorSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-operator"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (name) => Effect.provideService(effect, Operator, name),
  }),
);

class WasReset extends Domain.Event("WasReset", { by: Schema.String }) {}
class NotAnOperator extends Domain.Rejection("NotAnOperator") {}
class ResetCounter extends Domain.Command("ResetCounter", {
  target: Schema.String,
  events: [WasReset],
  rejects: [NotAnOperator],
  reply: { total: Schema.Number },
  middleware: [OperatorSession],
}) {}

/** Guests may not read counters. */
const notGuest = Effect.fn(function* () {
  if ((yield* Operator) === "guest") return yield* new NotAnOperator();
});

class Increment extends Domain.Command("Increment", {
  target: Schema.String,
  input: { by: Schema.Number },
  events: [Incremented],
  rejects: [TooBig],
  reply: { total: Schema.Number },
}) {}
class Cap extends Domain.Command("Cap", { target: Schema.String, events: [Capped] }) {}
class Reminded extends Domain.Event("Reminded") {}
/** Never rejects, so it can be scheduled. */
class Remind extends Domain.Command("Remind", { target: Schema.String, events: [Reminded] }) {}

class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number, capped: Schema.Boolean }),
  initial: { total: 0, capped: false },
  commands: [Increment, Cap, ResetCounter, Remind],
  decide: {
    ResetCounter: Effect.fn(function* () {
      const operator = yield* Operator;
      if (operator === "guest") return yield* new NotAnOperator();
      return [new WasReset({ by: operator })];
    }),
    Increment: (s, cmd) =>
      cmd.by > 10
        ? new TooBig({ max: 10 })
        : [new Incremented({ by: cmd.by, total: s.total + cmd.by })],
    Cap: (s) => (s.capped ? [] : [new Capped()]),
    Remind: (s) => (s.capped ? [new Reminded()] : []),
  },
  evolve: {
    Incremented: (s, e) => ({ ...s, total: e.total }),
    Capped: (s) => ({ ...s, capped: true }),
    WasReset: (s) => ({ ...s, total: 0 }),
    Reminded: (s) => s,
  },
  reply: {
    Increment: (s) => ({ total: s.total }),
    ResetCounter: (s) => ({ total: s.total }),
  },
  read: {
    middleware: [OperatorSession],
    rejects: [NotAnOperator],
    validate: () => notGuest(),
  },
}) {}

class Totals extends Domain.View("Totals", {
  from: [Counter],
  key: Counter,
  middleware: [OperatorSession],
  rejects: [NotAnOperator],
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: {
    Incremented: (_, e) => ({ total: e.total }),
    WasReset: () => ({ total: 0 }),
  },
  validate: () => notGuest(),
}) {}

class Logged extends Domain.Event("Logged", { by: Schema.Number }) {}

// A view without state that maps events.
class History extends Domain.View("History", {
  from: [Counter],
  key: Counter,
  events: [Logged],
  emit: { Incremented: (e) => new Logged({ by: e.by }) },
}) {}

// Moves between counters exercise named routes, view-to-view state and a
// policy listening to a view.
class Moved extends Domain.Event("Moved", {
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Number,
}) {}
class MakeMove extends Domain.Command("MakeMove", {
  target: Schema.String,
  input: { from: Schema.String, to: Schema.String, amount: Schema.Number },
  events: [Moved],
}) {}
class Move extends Domain.Aggregate("Move", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [MakeMove],
  decide: { MakeMove: (_, { from, to, amount }) => [new Moved({ from, to, amount })] },
  evolve: { Moved: (s) => s },
}) {}

class Flowed extends Domain.Event("Flowed", {
  direction: Schema.Literals(["in", "out"]),
  amount: Schema.Number,
}) {}

class Flows extends Domain.View("Flows", {
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
class Rich extends Domain.View("Rich", {
  from: [Flows],
  key: Counter,
  state: Schema.Struct({ rich: Schema.Boolean }),
  initial: { rich: false },
  evolve: { Flows: (_, __, { state }) => ({ rich: (state?.balance ?? 0) >= 100 }) },
}) {}

class CapWhenOverdrawn extends Domain.Policy("CapWhenOverdrawn", { from: Flows, on: [Flowed] }) {}
const CapWhenOverdrawnLive = CapWhenOverdrawn.toLayer(
  Effect.gen(function* () {
    const counters = yield* Counter;
    return Effect.fn(function* ({ source, state }) {
      if (state && state.balance < 0) yield* counters.send(source, new Cap());
    });
  }),
);

class Approval extends Domain.ExternalSystem("Approval", {
  check: { args: { total: Schema.Number }, success: { ok: Schema.Boolean } },
}) {}

class CapWhenLarge extends Domain.Policy("CapWhenLarge", { from: Counter, on: [Incremented] }) {}
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

// An hour after a counter is capped, remind someone.
class RemindWhenCapped extends Domain.Policy("RemindWhenCapped", { from: Counter, on: [Capped] }) {}
const RemindWhenCappedLive = RemindWhenCapped.toLayer(
  Effect.gen(function* () {
    const counters = yield* Counter;
    return Effect.fn(function* ({ source }) {
      yield* counters.schedule(source, new Remind(), { after: "1 hour" });
    });
  }),
);

class Counters extends Domain.Model("Counters", {
  aggregates: [Counter, Move],
  views: [Totals, History, Flows, Rich],
  policies: [CapWhenLarge, CapWhenOverdrawn, RemindWhenCapped],
}) {}

const story = Story.make(Counters, {
  layer: Layer.mergeAll(CapWhenLargeLive, CapWhenOverdrawnLive, RemindWhenCappedLive),
  externalSystems: [Approval],
});
const c1 = Counter.ref("c-1");
const c2 = Counter.ref("c-2");
const m1 = Move.ref("m-1");

describe("Domain Story", () => {
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

  it.effect("suspends a policy on an external system call until it is resolved", () =>
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

  it.effect("answers two pending calls by tag, in any order", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.given(c2, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 6 })),
      Story.when(c2, new Increment({ by: 10 })),
      Story.expectCall("c1", Approval.check, { total: 16 }),
      Story.expectCall("c2", Approval.check, { total: 20 }),
      Story.resolve("c2", Approval.check, { ok: false }),
      Story.resolve("c1", Approval.check, { ok: true }),
      Story.then(c1, new Incremented({ by: 6, total: 16 }), new Capped()),
      Story.then(c2, new Incremented({ by: 10, total: 20 })),
    ),
  );

  it.effect("tells identical calls apart by who made them", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.given(c2, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 6 })),
      Story.when(c2, new Increment({ by: 6 })),
      Story.expectCall("c2", Approval.check, { total: 16 }, { by: CapWhenLarge, key: c2 }),
      Story.expectCall("c1", Approval.check, { total: 16 }, { by: CapWhenLarge, key: c1 }),
      Story.resolve("c1", Approval.check, { ok: false }),
      Story.resolve("c2", Approval.check, { ok: true }),
      Story.then(c1, new Incremented({ by: 6, total: 16 })),
      Story.then(c2, new Incremented({ by: 6, total: 16 }), new Capped()),
    ),
  );

  it.effect("an untagged resolve with several pending calls fails", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.given(c2, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 6 })),
      Story.when(c2, new Increment({ by: 6 })),
      Story.resolve(Approval.check, { ok: true }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain("2 pending calls to Approval.check"),
      ),
    ),
  );

  it.effect("identical calls can't be tagged without saying who made them", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.given(c2, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 6 })),
      Story.when(c2, new Increment({ by: 6 })),
      Story.expectCall("c1", Approval.check, { total: 16 }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain(
          "2 pending calls to Approval.check match",
        ),
      ),
    ),
  );

  it.effect("resolving a tag no call has fails", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 6 })),
      Story.expectCall("c1", Approval.check, { total: 16 }),
      Story.resolve("c3", Approval.check, { ok: true }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain(
          'no pending call is named "c3"; named: "c1"',
        ),
      ),
    ),
  );

  it.effect("fails on an unasserted rejection", () =>
    story(Story.when(c1, new Increment({ by: 99 }))).pipe(
      Effect.flip,
      Effect.map((failure) => expect(String((failure as any).message)).toContain("TooBig")),
    ),
  );

  it.effect("fails on an unresolved external system call", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 9 })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain("unresolved external system calls"),
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

  it.effect("decide reads the context its command's middleware provides", () =>
    story(
      Story.given(c1, new Incremented({ by: 4, total: 4 })),
      Story.provide(Operator, "sam"),
      Story.when(c1, new ResetCounter()),
      Story.then(c1, new WasReset({ by: "sam" })),
      Story.replied({ total: 0 }),
      Story.provide(Operator, "guest"),
      Story.when(c1, new ResetCounter()),
      Story.rejected(new NotAnOperator()),
    ),
  );

  it.effect("a command without its context fails", () =>
    story(Story.when(c1, new ResetCounter())).pipe(
      Effect.flip,
      Effect.map((failure) => expect(String(failure)).toContain("Test/Operator")),
      Effect.catchDefect((defect) =>
        Effect.sync(() => expect(String(defect)).toContain("Test/Operator")),
      ),
    ),
  );

  it.live("an Api exposes a command; its middleware provides the context", () =>
    Effect.gen(function* () {
      class CounterApi extends Domain.Api("CounterApi", ResetCounter) {}
      const client = yield* CounterApi.testClient;
      const counters = yield* Counter;
      yield* counters.send(c1, new Increment({ by: 3 }));
      const reset = yield* client.ResetCounter(
        { target: "c-1" },
        { headers: Headers.fromInput({ "x-operator": "sam" }) },
      );
      expect(reset).toEqual({ reply: { total: 0 }, stream: "Counter/c-1", version: 2 });
      const denied = yield* client
        .ResetCounter({ target: "c-1" }, { headers: Headers.fromInput({ "x-operator": "guest" }) })
        .pipe(Effect.flip);
      expect(denied._tag).toBe("NotAnOperator");
      const anonymous = yield* client.ResetCounter({ target: "c-1" }).pipe(Effect.flip);
      expect(anonymous._tag).toBe("Unauthenticated");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          OperatorSessionLive,
          Counters.layer(
            Layer.mergeAll(CapWhenLargeLive, CapWhenOverdrawnLive, RemindWhenCappedLive),
          ),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              InMemory,
              Approval.toLayer(Effect.succeed({ check: () => Effect.succeed({ ok: false }) })),
            ),
          ),
        ),
      ),
    ),
  );

  it.live("an Api exposes views and aggregates; validate judges every read", () =>
    Effect.gen(function* () {
      class CounterApi extends Domain.Api("CounterApi", ResetCounter, Totals, Counter) {}
      const client = yield* CounterApi.testClient;
      const counters = yield* Counter;
      const sam = { headers: Headers.fromInput({ "x-operator": "sam" }) };
      const guest = { headers: Headers.fromInput({ "x-operator": "guest" }) };

      const receipt = yield* counters.send(c1, new Increment({ by: 3 }));
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(yield* client.Totals.get("c-1", { ...sam, atLeast })).toEqual({ total: 3 });
      // The client's filter only narrows what a permitted read returns.
      expect(
        yield* client.Totals.get("c-1", { ...sam, atLeast, where: { total: { gt: 10 } } }),
      ).toBeNull();
      expect((yield* client.Totals.get("c-1", guest).pipe(Effect.flip))._tag).toBe("NotAnOperator");
      expect(yield* client.Counter.get("c-1", sam)).toEqual({ total: 3, capped: false });
      expect((yield* client.Counter.get("c-1", guest).pipe(Effect.flip))._tag).toBe(
        "NotAnOperator",
      );

      // A watch sees the current state, then each change.
      const totals = yield* client.Totals.watch("c-1", sam).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      const states = yield* client.Counter.watch("c-1", sam).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.sleep("20 millis");
      yield* counters.send(c1, new Increment({ by: 2 }));
      expect(yield* Fiber.join(totals)).toEqual([{ total: 3 }, { total: 5 }]);
      expect((yield* Fiber.join(states)).map((s) => s.total)).toEqual([3, 5]);

      const events = yield* client.Counter.events("c-1", sam).pipe(
        Stream.take(2),
        Stream.runCollect,
      );
      expect(events.map((e) => e.event._tag)).toEqual(["Incremented", "Incremented"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          OperatorSessionLive,
          Counters.layer(
            Layer.mergeAll(CapWhenLargeLive, CapWhenOverdrawnLive, RemindWhenCappedLive),
          ),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              InMemory,
              Approval.toLayer(Effect.succeed({ check: () => Effect.succeed({ ok: false }) })),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("a scheduled command fires when the clock reaches it", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(c1, new Cap()),
      Story.then(c1, new Capped()),
      Story.clock("2026-01-01T00:59:00Z"),
      Story.then(c1),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(c1, new Reminded()),
    ),
  );
});
