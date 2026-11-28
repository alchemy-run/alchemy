import * as Domain from "@alchemy.run/domain";
import { errorSchema } from "@alchemy.run/domain/ExternalSystem";
import { InMemory } from "@alchemy.run/domain/InMemory";
import {
  type Checked,
  type ProvideStep,
  type RejectedStep,
  type RepliedStep,
  type Step,
  Story,
  type WhenStep,
} from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Activity, DurableDeferred } from "effect/workflow";

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
  input: { id: Schema.String },
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
  input: { id: Schema.String, by: Schema.Number },
  events: [Incremented],
  rejects: [TooBig],
  reply: { total: Schema.Number },
}) {}
class Cap extends Domain.Command("Cap", { input: { id: Schema.String }, events: [Capped] }) {}
class Reminded extends Domain.Event("Reminded") {}
/** Never rejects, so it can be scheduled. */
class Remind extends Domain.Command("Remind", {
  input: { id: Schema.String },
  events: [Reminded],
}) {}

class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number, capped: Schema.Boolean }),
  initial: { total: 0, capped: false },
  commands: [Increment, Cap, ResetCounter, Remind],
  keyOf: (command) => command.id,
  decide: {
    ResetCounter: Effect.fn(function* () {
      const operator = yield* Operator;
      if (operator === "guest") return yield* new NotAnOperator();
      return [new WasReset({ by: operator })];
    }),
    Increment: (counter, cmd) =>
      cmd.by > 10
        ? new TooBig({ max: 10 })
        : [new Incremented({ by: cmd.by, total: counter.total + cmd.by })],
    Cap: (counter) => (counter.capped ? [] : [new Capped()]),
    Remind: (counter) => (counter.capped ? [new Reminded()] : []),
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
}) {}

/** Who may read each key of Totals. */

const TotalsLive = Totals.toLayer(Effect.succeed(() => notGuest()));

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
  input: { id: Schema.String, from: Schema.String, to: Schema.String, amount: Schema.Number },
  events: [Moved],
}) {}
class Move extends Domain.Aggregate("Move", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [MakeMove],
  keyOf: (command) => command.id,
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
      if (state && state.balance < 0) yield* counters.send(new Cap({ id: source.id }));
    });
  }),
);

class ApprovalUnavailable extends Domain.Rejection("ApprovalUnavailable") {}

class Approval extends Domain.ExternalSystem("Approval", {
  check: {
    args: { total: Schema.Number },
    success: { ok: Schema.Boolean },
    error: ApprovalUnavailable,
  },
}) {}

class CapWhenLarge extends Domain.Policy("CapWhenLarge", { from: Counter, on: [Incremented] }) {}
const CapWhenLargeLive = CapWhenLarge.toLayer(
  Effect.gen(function* () {
    const approval = yield* Approval;
    const counters = yield* Counter;
    return Effect.fn(function* ({ source, event }) {
      if (event.total < 15) return;
      // Without an answer, the counter stays uncapped.
      const ok = yield* approval.check({ total: event.total }).pipe(
        Effect.map(({ ok }) => ok),
        Effect.catchTag("ApprovalUnavailable", () => Effect.succeed(false)),
      );
      if (ok) yield* counters.send(new Cap({ id: source.id }));
    });
  }),
);

// An hour after a counter is capped, remind someone.
class RemindWhenCapped extends Domain.Policy("RemindWhenCapped", { from: Counter, on: [Capped] }) {}
const RemindWhenCappedLive = RemindWhenCapped.toLayer(
  Effect.gen(function* () {
    const counters = yield* Counter;
    return Effect.fn(function* ({ source }) {
      yield* counters.schedule(new Remind({ id: source.id }), { after: "1 hour" });
    });
  }),
);

class Counters extends Domain.Model("Counters", {
  aggregates: [Counter, Move],
  views: [Totals, History, Flows, Rich],
  policies: [CapWhenLarge, CapWhenOverdrawn, RemindWhenCapped],
}) {}

const story = Story.make(Counters, {
  layer: Layer.mergeAll(CapWhenLargeLive, CapWhenOverdrawnLive, RemindWhenCappedLive, TotalsLive),
  stub: [Approval],
});

// Approval called for real, through an adapter: 20 and over is unavailable,
// 17 breaks the connection, 19 answers slowly, and even totals are approved.
const ApprovalAdapter = Approval.toLayer(
  Effect.succeed({
    check: ({ total }) =>
      total >= 20
        ? Effect.fail(new ApprovalUnavailable())
        : total === 17
          ? Effect.die(new Error("socket closed"))
          : Effect.succeed({ ok: total % 2 === 0 }).pipe(
              Effect.delay(total === 19 ? "50 millis" : "0 millis"),
            ),
  }),
);
const unstubbed = Story.make(Counters, {
  layer: Layer.mergeAll(CapWhenLargeLive, CapWhenOverdrawnLive, RemindWhenCappedLive, TotalsLive),
});
const real = (...steps: ReadonlyArray<Step>) =>
  unstubbed(...steps).pipe(Effect.provide(ApprovalAdapter));

// A system that is not stubbed must be provided as a Layer.
// @ts-expect-error Approval is not provided
export const unprovided: Effect.Effect<void, unknown, never> = unstubbed();

// Each step is checked against the last command: `rejected` takes only a
// rejection it declares, `replied` only its reply type, and a command whose
// middleware provides a service needs a `provide` step for it first.
export const typed = () => [
  story(Story.when(new Increment({ id: c1.id, by: 11 })), Story.rejected(new TooBig({ max: 10 }))),
  story(Story.when(new Increment({ id: c1.id, by: 1 })), Story.replied({ total: 1 })),
  story(Story.provide(Operator, "sam"), Story.when(new ResetCounter({ id: c1.id }))),
  // @ts-expect-error Increment does not reject with NotAnOperator
  story(Story.when(new Increment({ id: c1, by: 1 })), Story.rejected(new NotAnOperator())),
  // @ts-expect-error Increment replies with a number total
  story(Story.when(new Increment({ id: c1, by: 1 })), Story.replied({ total: "1" })),
  // @ts-expect-error Cap declares no reply
  story(Story.when(new Cap({ id: c1 })), Story.replied({ total: 1 })),
  // @ts-expect-error ResetCounter's middleware provides Operator, and no step does
  story(Story.when(new ResetCounter({ id: c1 }))),
  // A step typed as a plain Step may be a `provide`, so it turns the checks off.
  story(Story.provide(Operator, "sam") as Step, Story.when(new ResetCounter({ id: c1.id }))),
];

// The type error names the mistake on the step that makes it.
export const messages: [
  Checked<[WhenStep<Increment>, RejectedStep<NotAnOperator>], typeof Increment>[1],
  Checked<[WhenStep<Cap>, RepliedStep<{ total: number }>], typeof Cap>[1],
  Checked<[WhenStep<ResetCounter>], typeof ResetCounter>[0],
  Checked<[ProvideStep<Operator>, WhenStep<ResetCounter>], typeof ResetCounter>[1],
] = [
  "Increment does not reject with NotAnOperator",
  "Cap declares no reply",
  "ResetCounter needs Story.provide(Test/Operator) before it",
  Story.when(new ResetCounter({ id: Counter.ref("c-1").id })),
];

const c1 = Counter.ref("c-1");
const c2 = Counter.ref("c-2");
const m1 = Move.ref("m-1");

describe("Domain Story", { tags: ["unit", "local"] }, () => {
  it.effect("decides, evolves, replies and projects", () =>
    story(
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.when(new Increment({ id: c1.id, by: 3 })),
      Story.then(c1, new Incremented({ by: 3, total: 5 })),
      Story.replied({ total: 5 }),
      Story.view(Totals, c1, { total: 5 }),
      Story.emitted(History, c1, [{ by: 2 }, { by: 3 }]),
    ),
  );

  it.effect("asserts part of an aggregate's state", () =>
    story(
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.state(c1, { total: 2 }),
      Story.state(c1, { total: 2, capped: false }),
    ),
  );

  it.effect("a partial state that does not match fails", () =>
    story(
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.state(c1, { total: 3 }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain(
          'Counter/c-1\n  expected {"total":3}\n  actual   {"total":2,"capped":false}',
        ),
      ),
    ),
  );

  it.effect("asserts rejections", () =>
    story(
      Story.when(new Increment({ id: c1.id, by: 11 })),
      Story.rejected(new TooBig({ max: 10 })),
      Story.then(c1),
    ),
  );

  it.effect("suspends a policy on an external system call until it is answered", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call(Approval.check, { total: 16 }),
      Story.then(c1, new Incremented({ by: 6, total: 16 })),
      Story.succeed(Approval.check, { ok: true }),
      Story.then(c1, new Capped()),
      Story.state(c1, (s) => expect(s.capped).toBe(true)),
    ),
  );

  it.effect("answers two pending calls by tag, in any order", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.given(c2, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.when(new Increment({ id: c2.id, by: 10 })),
      Story.call("c1", Approval.check, { total: 16 }),
      Story.call("c2", Approval.check, { total: 20 }),
      Story.succeed("c2", Approval.check, { ok: false }),
      Story.succeed("c1", Approval.check, { ok: true }),
      Story.then(c1, new Incremented({ by: 6, total: 16 }), new Capped()),
      Story.then(c2, new Incremented({ by: 10, total: 20 })),
    ),
  );

  it.effect("tags identical calls in the order they were made", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.given(c2, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.when(new Increment({ id: c2.id, by: 6 })),
      Story.call("c1", Approval.check, { total: 16 }),
      Story.call("c2", Approval.check, { total: 16 }),
      Story.succeed("c1", Approval.check, { ok: false }),
      Story.succeed("c2", Approval.check, { ok: true }),
      Story.then(c1, new Incremented({ by: 6, total: 16 })),
      Story.then(c2, new Incremented({ by: 6, total: 16 }), new Capped()),
    ),
  );

  it.effect("fails a pending call with the operation's declared error", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call(Approval.check, { total: 16 }),
      Story.fail(Approval.check, new ApprovalUnavailable()),
      Story.then(c1, new Incremented({ by: 6, total: 16 })),
      Story.state(c1, (s) => expect(s.capped).toBe(false)),
    ),
  );

  it.effect("a pending call that dies fails the policy", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call("c1", Approval.check, { total: 16 }),
      Story.die("c1", Approval.check, new Error("socket closed")),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toMatch(
          /a policy or projection failed: .*socket closed/,
        ),
      ),
    ),
  );

  it.effect("an answer the success schema rejects fails the policy", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call(Approval.check, { total: 16 }),
      Story.succeed(Approval.check, { ok: "yes" } as never),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toMatch(
          /a policy or projection failed: .*Approval\.check returned a value its success schema rejects/s,
        ),
      ),
    ),
  );

  it.effect("asserts what a real call was sent and returned", () =>
    real(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call(Approval.check, { total: 16 }),
      Story.returned(Approval.check, { ok: true }),
      Story.then(c1, new Incremented({ by: 6, total: 16 }), new Capped()),
    ),
  );

  it.effect("asserts a real call's declared error", () =>
    real(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 10 })),
      Story.call(Approval.check, { total: 20 }),
      Story.failed(Approval.check, new ApprovalUnavailable()),
      Story.then(c1, new Incremented({ by: 10, total: 20 })),
    ),
  );

  it.effect("asserts that a real call died", () =>
    real(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 7 })),
      Story.call("c1", Approval.check, { total: 17 }),
      Story.died("c1", Approval.check),
    ).pipe(
      Effect.flip,
      // The policy did not handle the defect, so the story still fails on it.
      Effect.map((failure) =>
        expect(String((failure as any).message)).toMatch(/a policy or projection failed/),
      ),
    ),
  );

  it.live("waits for a slow real call", () =>
    real(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 9 })),
      Story.call(Approval.check, { total: 19 }),
      Story.returned(Approval.check, { ok: false }),
      Story.then(c1, new Incremented({ by: 9, total: 19 })),
    ),
  );

  it.effect("a real call returning something else fails", () =>
    real(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call(Approval.check, { total: 16 }),
      Story.returned(Approval.check, { ok: false }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain(
          'expected {"_tag":"Success","value":{"ok":false}}',
        ),
      ),
    ),
  );

  it.effect("a real call no step asserts fails the story", () =>
    real(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call(Approval.check, { total: 16 }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain(
          "real external system calls no step asserts",
        ),
      ),
    ),
  );

  it.effect("answering a call no call step checked fails", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.succeed(Approval.check, { ok: true }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain(
          'Approval.check({"total":16}) is answered before a call step checks its arguments',
        ),
      ),
    ),
  );

  it.effect("asserting a real call no call step checked fails", () =>
    real(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.returned(Approval.check, { ok: true }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain(
          'Approval.check({"total":16}) is asserted before a call step checks its arguments',
        ),
      ),
    ),
  );

  it.effect("an untagged succeed with several pending calls fails", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.given(c2, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.when(new Increment({ id: c2.id, by: 6 })),
      Story.succeed(Approval.check, { ok: true }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain("2 pending calls to Approval.check"),
      ),
    ),
  );

  it.effect("answering a tag no call has fails", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call("c1", Approval.check, { total: 16 }),
      Story.succeed("c3", Approval.check, { ok: true }),
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
    story(Story.when(new Increment({ id: c1.id, by: 99 }))).pipe(
      Effect.flip,
      Effect.map((failure) => expect(String((failure as any).message)).toContain("TooBig")),
    ),
  );

  it.effect("fails on an unanswered external system call", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 9 })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain("unanswered external system calls"),
      ),
    ),
  );

  it.effect("routes one event to two keys, each with its own handlers", () =>
    story(
      Story.when(new MakeMove({ id: m1.id, from: "c-1", to: "c-2", amount: 30 })),
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
      Story.when(new ResetCounter({ id: c1.id })),
      Story.then(c1, new WasReset({ by: "sam" })),
      Story.replied({ total: 0 }),
      Story.provide(Operator, "guest"),
      Story.when(new ResetCounter({ id: c1.id })),
      Story.rejected(new NotAnOperator()),
    ),
  );

  it.effect("provideWith computes the service again for each command", () =>
    Effect.suspend(() => {
      let turn = 0;
      return story(
        Story.provideWith(Operator, () => Effect.sync(() => `op-${++turn}`)),
        Story.when(new ResetCounter({ id: c1.id })),
        Story.then(c1, new WasReset({ by: "op-1" })),
        Story.when(new ResetCounter({ id: c1.id })),
        Story.then(c1, new WasReset({ by: "op-2" })),
      );
    }),
  );

  it.effect("provideWith sees the command and the instances it is for", () =>
    story(
      Story.provideWith(Operator, ({ command, refs }) =>
        Effect.succeed(`${command._tag}@${refs.map((ref) => String(ref.id)).join(",")}`),
      ),
      Story.when(new ResetCounter({ id: c1.id })),
      Story.then(c1, new WasReset({ by: "ResetCounter@c-1" })),
      Story.when(new ResetCounter({ id: c2.id })),
      Story.then(c2, new WasReset({ by: "ResetCounter@c-2" })),
    ),
  );

  it.effect("provideWith gives each instance its own caller", () =>
    story(
      Story.provideWith(Operator, ({ refs }) =>
        Effect.succeed(refs[0]!.id === c1.id ? "sam" : "guest"),
      ),
      Story.when(new ResetCounter({ id: c1.id })),
      Story.then(c1, new WasReset({ by: "sam" })),
      Story.when(new ResetCounter({ id: c2.id })),
      Story.rejected(new NotAnOperator()),
    ),
  );

  it.effect("provideWith that fails fails the when it was computed for", () =>
    story(
      Story.provideWith(Operator, () => Effect.fail("no session")),
      Story.given(c1, new Incremented({ by: 1, total: 1 })),
      Story.when(new ResetCounter({ id: c1.id })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.step).toBe(3);
        expect(failure.reason).toBe("When: Test/Operator could not be provided: no session");
      }),
    ),
  );

  it.effect("a later provide replaces a provideWith, and the other way round", () =>
    story(
      Story.provideWith(Operator, () => Effect.succeed("computed")),
      Story.provide(Operator, "sam"),
      Story.when(new ResetCounter({ id: c1.id })),
      Story.then(c1, new WasReset({ by: "sam" })),
      Story.provideWith(Operator, () => Effect.succeed("computed")),
      Story.when(new ResetCounter({ id: c1.id })),
      Story.then(c1, new WasReset({ by: "computed" })),
    ),
  );

  it.effect("a failed story shows a provideWith step as computed at each when", () =>
    story(
      Story.provideWith(Operator, () => Effect.succeed("sam")),
      Story.when(new ResetCounter({ id: c1.id })),
      Story.then(c1, new WasReset({ by: "alex" })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.steps[0]!.summary).toBe("Test/Operator = (computed at each when)");
        expect(failure.message).toContain("1 Provide    Test/Operator = (computed at each when)");
      }),
    ),
  );

  it.effect("a command without its context fails", () =>
    // @ts-expect-error ResetCounter's middleware provides Operator, and no step does
    story(Story.when(new ResetCounter({ id: c1.id }))).pipe(
      Effect.flip,
      Effect.map((failure) => expect(String(failure)).toContain("Test/Operator")),
      Effect.catchDefect((defect) =>
        Effect.sync(() => expect(String(defect)).toContain("Test/Operator")),
      ),
    ),
  );

  it.live("an Api exposes a command; its middleware provides the context", () =>
    Effect.gen(function* () {
      class CounterApi extends Domain.Api("CounterApi", {
        model: Counters,
        commands: ["ResetCounter"],
      }) {}
      const client = yield* CounterApi.clientInProcess;
      const counters = yield* Counter;
      yield* counters.send(new Increment({ id: c1.id, by: 3 }));
      const reset = yield* client.ResetCounter(
        { id: "c-1" },
        { headers: Headers.fromInput({ "x-operator": "sam" }) },
      );
      expect(reset).toEqual({
        reply: { total: 0 },
        stream: "Counter/c-1",
        version: 2,
        commits: [{ stream: "Counter/c-1", version: 2 }],
      });
      const denied = yield* client
        .ResetCounter({ id: "c-1" }, { headers: Headers.fromInput({ "x-operator": "guest" }) })
        .pipe(Effect.flip);
      expect(denied._tag).toBe("NotAnOperator");
      const anonymous = yield* client.ResetCounter({ id: "c-1" }).pipe(Effect.flip);
      expect(anonymous._tag).toBe("Unauthenticated");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          OperatorSessionLive,
          Counters.layer(
            Layer.mergeAll(
              CapWhenLargeLive,
              CapWhenOverdrawnLive,
              RemindWhenCappedLive,
              TotalsLive,
            ),
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

  it.live("an Api exposes views; validate judges every read", () =>
    Effect.gen(function* () {
      class CounterApi extends Domain.Api("CounterApi", {
        model: Counters,
        commands: ["ResetCounter"],
        views: ["Totals"],
      }) {}
      const client = yield* CounterApi.clientInProcess;
      const counters = yield* Counter;
      const sam = { headers: Headers.fromInput({ "x-operator": "sam" }) };
      const guest = { headers: Headers.fromInput({ "x-operator": "guest" }) };

      const receipt = yield* counters.send(new Increment({ id: c1.id, by: 3 }));
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(yield* client.Totals.get("c-1", { ...sam, atLeast })).toEqual({ total: 3 });
      // The client's filter only narrows what a permitted read returns.
      expect(
        yield* client.Totals.get("c-1", { ...sam, atLeast, where: { total: { gt: 10 } } }),
      ).toBeNull();
      expect((yield* client.Totals.get("c-1", guest).pipe(Effect.flip))._tag).toBe("NotAnOperator");
      // A snapshot is judged like a get, and its filter narrows the same way.
      expect(yield* client.Totals.snapshot("c-1", { ...sam, atLeast })).toEqual({
        state: { total: 3 },
        cursor: 1,
      });
      expect(
        (yield* client.Totals.snapshot("c-1", { ...sam, where: { total: { gt: 10 } } })).state,
      ).toBeNull();
      expect((yield* client.Totals.snapshot("c-1", guest).pipe(Effect.flip))._tag).toBe(
        "NotAnOperator",
      );
      expect((yield* client.Totals.list("c-1", guest).pipe(Effect.flip))._tag).toBe(
        "NotAnOperator",
      );

      // A read without a session fails with the middleware's error, and the client's type has it.
      const anonymous = [
        yield* client.Totals.get("c-1").pipe(
          Effect.catchTag("Unauthenticated", (e) => Effect.succeed(e._tag)),
        ),
        yield* client.Totals.watch("c-1").pipe(
          Stream.runCollect,
          Effect.catchTag("Unauthenticated", (e) => Effect.succeed(e._tag)),
        ),
        yield* client.Totals.events("c-1").pipe(
          Stream.runCollect,
          Effect.catchTag("Unauthenticated", (e) => Effect.succeed(e._tag)),
        ),
      ];
      expect(anonymous).toEqual(Array(3).fill("Unauthenticated"));

      // A watch sees the current state, then each change.
      const totals = yield* client.Totals.watch("c-1", sam).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.sleep("20 millis");
      yield* counters.send(new Increment({ id: c1.id, by: 2 }));
      expect(yield* Fiber.join(totals)).toEqual([
        { state: { total: 3 }, cursor: 1 },
        { state: { total: 5 }, cursor: 2 },
      ]);

      const events = yield* client.Totals.events("c-1", sam).pipe(
        Stream.filter(Domain.Read.isEvent),
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
            Layer.mergeAll(
              CapWhenLargeLive,
              CapWhenOverdrawnLive,
              RemindWhenCappedLive,
              TotalsLive,
            ),
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

  it.effect("a failed then reports every step and the events so far", () =>
    story(
      Story.clock("2026-03-01T09:00:00Z"),
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.when(new Increment({ id: c1.id, by: 3 })),
      Story.then(c1, new Incremented({ by: 4, total: 6 })),
      Story.replied({ total: 6 }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.step).toBe(4);
        expect(failure.reason).toContain("Then: on Counter/c-1");
        expect(failure.message).toBe(
          [
            failure.reason,
            "",
            "  ✓ 1 Clock      2026-03-01T09:00:00.000Z",
            "  ✓ 2 Given      Counter/c-1: Incremented { by: 2, total: 2 }",
            '  ✓ 3 When       Increment { id: "c-1", by: 3 }',
            "  ✗ 4 Then       Counter/c-1: expected Incremented { by: 4, total: 6 }",
            "                              got      Incremented { by: 3, total: 5 }",
            "    5 Replied    { total: 6 }",
            "  events so far",
            "    Counter/c-1: Incremented → Incremented",
          ].join("\n"),
        );
        expect(failure.steps.map((s) => s.status)).toEqual([
          "passed",
          "passed",
          "passed",
          "failed",
          "not-run",
        ]);
        expect(failure.events).toEqual({ "Counter/c-1": ["Incremented", "Incremented"] });
      }),
    ),
  );

  it.effect("an unasserted rejection is marked on its command", () =>
    story(
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.when(new Increment({ id: c1.id, by: 99 })),
      Story.then(c1),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(failure.message).toBe(
          [
            "the command was rejected with TooBig, which no step asserts",
            "",
            "  ✓ 1 Given      Counter/c-1: Incremented { by: 2, total: 2 }",
            '  ✗ 2 When       Increment { id: "c-1", by: 99 }',
            "                 rejected TooBig { max: 10 }",
            "    3 Then       Counter/c-1: nothing new",
            "  events so far",
            "    Counter/c-1: Incremented",
          ].join("\n"),
        ),
      ),
    ),
  );

  it.effect("a wrong rejection shows what was expected and what came", () =>
    story(
      Story.when(new Increment({ id: c1.id, by: 99 })),
      Story.rejected(new TooBig({ max: 5 })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(failure.message.split("\n\n")[1]).toBe(
          [
            '  ✓ 1 When       Increment { id: "c-1", by: 99 }',
            "  ✗ 2 Rejected   expected TooBig { max: 5 }",
            "                 got      TooBig { max: 10 }",
            "  events so far",
            "    Counter/c-1: nothing",
          ].join("\n"),
        ),
      ),
    ),
  );

  it.effect("a view that emits an event it does not declare fails with a DefinitionError", () => {
    class Loud extends Domain.View("Loud", {
      from: [Counter],
      key: Counter,
      events: [Logged],
      emit: { Incremented: () => new Capped() as never },
    }) {}
    class Louds extends Domain.Model("Louds", { aggregates: [Counter], views: [Loud] }) {}
    return Story.make(Louds)(Story.when(new Increment({ id: c1.id, by: 1 }))).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure._tag).toBe("StoryFailure");
        expect(failure.reason).toContain(
          "DefinitionError: Loud emitted 'Capped', which it does not declare in events",
        );
      }),
    );
  });

  it.effect("a failed policy is marked on the step that ran it", () => {
    class Boom extends Domain.Policy("Boom", { from: Counter, on: [Capped] }) {}
    class Breaks extends Domain.Model("Breaks", { aggregates: [Counter], policies: [Boom] }) {}
    const breaks = Story.make(Breaks, {
      layer: Boom.toLayer(Effect.succeed(() => Effect.die(new Error("boom")))),
    });
    return breaks(
      Story.when(new Increment({ id: c1.id, by: 1 })),
      Story.when(new Cap({ id: c1.id })),
      Story.then(c1, new Incremented({ by: 1, total: 1 }), new Capped()),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.step).toBe(2);
        expect(failure.reason).toContain("a policy or projection failed");
        expect(failure.reason).toContain("boom");
        expect(failure.message.split("\n\n").at(-1)).toBe(
          [
            '  ✓ 1 When       Increment { id: "c-1", by: 1 }',
            '  ✗ 2 When       Cap { id: "c-1" }',
            "    3 Then       Counter/c-1: Incremented { by: 1, total: 1 }, Capped",
            "  events so far",
            "    Counter/c-1: Incremented → Capped",
          ].join("\n"),
        );
      }),
    );
  });

  it.effect("a report never prints a redacted value", () => {
    class Keyed extends Domain.Event("Keyed", { secret: Schema.Redacted(Schema.String) }) {}
    class SetKey extends Domain.Command("SetKey", {
      input: { id: Schema.String, secret: Schema.Redacted(Schema.String) },
      events: [Keyed],
    }) {}
    class Lock extends Domain.Aggregate("Lock", {
      id: Schema.String,
      state: Schema.Struct({}),
      initial: {},
      commands: [SetKey],
      keyOf: (command) => command.id,
      decide: { SetKey: (_, { secret }) => [new Keyed({ secret })] },
      evolve: { Keyed: (s) => s },
    }) {}
    class Locks extends Domain.Model("Locks", { aggregates: [Lock] }) {}
    const lock = Lock.ref("l-1");
    return Story.make(Locks)(
      Story.when(new SetKey({ id: lock.id, secret: Redacted.make("hunter2") })),
      Story.then(lock, new Keyed({ secret: Redacted.make("swordfish") })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.message).not.toContain("hunter2");
        expect(failure.message).not.toContain("swordfish");
        expect(failure.message).toContain(
          "  ✗ 2 Then       Lock/l-1: expected Keyed { secret: <redacted> }",
        );
      }),
    );
  });

  it.effect("fails on a committed event no step asserts", () =>
    story(
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.when(new Increment({ id: c1.id, by: 3 })),
      Story.replied({ total: 5 }),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.step).toBe(3);
        expect(failure.reason).toBe(
          "committed events no step asserts (assert them with then): Counter/c-1: Incremented { by: 3, total: 5 } (from step 2)",
        );
        expect(failure.message.split("\n\n")[1]).toBe(
          [
            "  ✓ 1 Given      Counter/c-1: Incremented { by: 2, total: 2 }",
            '  ✓ 2 When       Increment { id: "c-1", by: 3 }',
            "  ✓ 3 Replied    { total: 5 }",
            "  ✗   end        Counter/c-1: Incremented { by: 3, total: 5 } (from step 2)",
            "  events so far",
            "    Counter/c-1: Incremented → Incremented",
          ].join("\n"),
        );
      }),
    ),
  );

  it.effect("fails on the events after the ones a then names", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(new Increment({ id: c1.id, by: 6 })),
      Story.call(Approval.check, { total: 16 }),
      Story.succeed(Approval.check, { ok: true }),
      Story.then(c1, new Incremented({ by: 6, total: 16 })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(failure.reason).toContain("Counter/c-1: Capped (from step 4)"),
      ),
    ),
  );

  it.effect("fails on events a policy commits on a stream no step names", () =>
    story(
      Story.when(new MakeMove({ id: m1.id, from: "c-1", to: "c-2", amount: 30 })),
      Story.then(m1, new Moved({ from: "c-1", to: "c-2", amount: 30 })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.reason).toContain("Counter/c-1: Capped (from step 1)");
        expect(failure.events).toEqual({ "Move/m-1": ["Moved"], "Counter/c-1": ["Capped"] });
      }),
    ),
  );

  it.effect("a scheduled command fires when the clock reaches it", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(new Cap({ id: c1.id })),
      Story.then(c1, new Capped()),
      Story.clock("2026-01-01T00:59:00Z"),
      Story.then(c1),
      Story.clock(DateTime.makeUnsafe("2026-01-01T01:00:00Z")),
      Story.then(c1, new Reminded()),
    ),
  );

  it.effect("the clock never moves back", () =>
    story(
      Story.clock("2026-01-02T00:00:00Z"),
      Story.when(new Increment({ id: c1.id, by: 1 })),
      Story.then(c1, new Incremented({ by: 1, total: 1 })),
      Story.clock("2026-01-01T12:00:00Z"),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.step).toBe(4);
        expect(failure.reason).toBe(
          "Clock: the clock cannot move back, from 2026-01-02T00:00:00.000Z to 2026-01-01T12:00:00.000Z",
        );
        expect(failure.message).toContain(
          [
            "  ✗ 4 Clock      expected 2026-01-02T00:00:00.000Z or later",
            "                 got      2026-01-01T12:00:00.000Z",
          ].join("\n"),
        );
      }),
    ),
  );

  it.effect("a command at the start time keeps the clock from moving before it", () =>
    story(
      Story.when(new Increment({ id: c1.id, by: 1 })),
      Story.then(c1, new Incremented({ by: 1, total: 1 })),
      Story.clock("2025-12-31T00:00:00Z"),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(failure.reason).toContain(
          "the clock cannot move back, from 2026-01-01T00:00:00.000Z",
        ),
      ),
    ),
  );

  it.effect("the first clock step may set any time, and the same time again", () =>
    story(
      Story.provide(Operator, "sam"),
      Story.clock("2025-06-01T00:00:00Z"),
      Story.when(new Increment({ id: c1.id, by: 1 })),
      Story.then(c1, new Incremented({ by: 1, total: 1 })),
      Story.clock("2025-06-01T00:00:00Z"),
    ),
  );

  it.effect("advance moves the clock forward by a duration", () =>
    story(
      Story.when(new Cap({ id: c1.id })),
      Story.then(c1, new Capped()),
      Story.advance("59 minutes"),
      Story.then(c1),
      Story.advance(Duration.minutes(1)),
      Story.then(c1, new Reminded()),
      Story.clock("2026-01-01T01:00:00Z"),
    ),
  );

  it.effect("advance by a negative duration fails", () =>
    story(Story.advance("-1 hour")).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.reason).toBe("Advance: the clock only moves forward, not by -1h");
        expect(failure.message).toContain("  ✗ 1 Advance    -1h");
      }),
    ),
  );

  it.effect("advance by something that is not a duration fails", () =>
    story(Story.advance("Infinity")).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.reason).toBe("Advance: Infinity is not a duration");
        expect(failure.message).toContain("  ✗ 1 Advance    Infinity");
      }),
    ),
  );

  it.effect("a clock step that is not a time fails", () =>
    story(Story.clock("tomorrow")).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.reason).toBe("Clock: tomorrow is not a time");
        expect(failure.message).toContain("  ✗ 1 Clock      tomorrow");
      }),
    ),
  );
});

// An operation that declares several errors: the policy handles each one.
class LockOffline extends Domain.Rejection("LockOffline") {}
class CodeTaken extends Domain.Rejection("CodeTaken", { code: Schema.String }) {}
class LockJammed extends Domain.Rejection("LockJammed") {}
class Keypad extends Domain.ExternalSystem("Keypad", {
  setCode: {
    args: { code: Schema.String },
    success: { codeId: Schema.String },
    error: [LockOffline, CodeTaken],
  },
}) {}

class CodeRequested extends Domain.Event("CodeRequested", { code: Schema.String }) {}
class CodeOutcome extends Domain.Event("CodeOutcome", { outcome: Schema.String }) {}
class RequestCode extends Domain.Command("RequestCode", {
  input: { id: Schema.String, code: Schema.String },
  events: [CodeRequested],
}) {}
class RecordOutcome extends Domain.Command("RecordOutcome", {
  input: { id: Schema.String, outcome: Schema.String },
  events: [CodeOutcome],
}) {}
class Door extends Domain.Aggregate("Door", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [RequestCode, RecordOutcome],
  keyOf: (command) => command.id,
  decide: {
    RequestCode: (_, { code }) => [new CodeRequested({ code })],
    RecordOutcome: (_, { outcome }) => [new CodeOutcome({ outcome })],
  },
  evolve: { CodeRequested: (s) => s, CodeOutcome: (s) => s },
}) {}
class SetCodeOnLock extends Domain.Policy("SetCodeOnLock", {
  from: Door,
  on: [CodeRequested],
}) {}
const SetCodeOnLockLive = SetCodeOnLock.toLayer(
  Effect.gen(function* () {
    const keypad = yield* Keypad;
    const doors = yield* Door;
    return Effect.fn(function* ({ source, event }) {
      const outcome = yield* keypad.setCode({ code: event.code }).pipe(
        Effect.map(({ codeId }) => `set ${codeId}`),
        Effect.catchTags({
          LockOffline: () => Effect.succeed("offline"),
          CodeTaken: ({ code }) => Effect.succeed(`taken ${code}`),
        }),
      );
      yield* doors.send(new RecordOutcome({ id: source.id, outcome }));
    });
  }),
);
class Doors extends Domain.Model("Doors", { aggregates: [Door], policies: [SetCodeOnLock] }) {}
const doorStory = Story.make(Doors, { layer: SetCodeOnLockLive, stub: [Keypad] });
const d1 = Door.ref("d-1");

// Only a declared error type-checks.
// @ts-expect-error LockJammed is not one of setCode's errors
export const undeclared = Story.fail(Keypad.setCode, new LockJammed());

// A union schema declares the same errors.
class UnionKeypad extends Domain.ExternalSystem("UnionKeypad", {
  setCode: { args: { code: Schema.String }, error: Schema.Union([LockOffline, CodeTaken]) },
}) {}
export const unionErrors = [
  Story.fail(UnionKeypad.setCode, new LockOffline()),
  Story.fail(UnionKeypad.setCode, new CodeTaken({ code: "1234" })),
];
// @ts-expect-error LockJammed is not in the union
export const undeclaredInUnion = Story.fail(UnionKeypad.setCode, new LockJammed());

describe("Domain Story: an operation with several errors", { tags: ["unit", "local"] }, () => {
  it.effect("fails a pending call with each declared error", () =>
    doorStory(
      Story.when(new RequestCode({ id: d1.id, code: "1234" })),
      Story.then(d1, new CodeRequested({ code: "1234" })),
      Story.call(Keypad.setCode, { code: "1234" }),
      Story.fail(Keypad.setCode, new LockOffline()),
      Story.then(d1, new CodeOutcome({ outcome: "offline" })),
      Story.when(new RequestCode({ id: d1.id, code: "5678" })),
      Story.then(d1, new CodeRequested({ code: "5678" })),
      Story.call(Keypad.setCode, { code: "5678" }),
      Story.fail(Keypad.setCode, new CodeTaken({ code: "5678" })),
      Story.then(d1, new CodeOutcome({ outcome: "taken 5678" })),
    ),
  );

  it.effect("answers a call with its success when it declares several errors", () =>
    doorStory(
      Story.when(new RequestCode({ id: d1.id, code: "1234" })),
      Story.call(Keypad.setCode, { code: "1234" }),
      Story.succeed(Keypad.setCode, { codeId: "k_1" }),
      Story.then(d1, new CodeRequested({ code: "1234" }), new CodeOutcome({ outcome: "set k_1" })),
    ),
  );

  it("reads every form of a declared error as one schema", () => {
    const declared = [new LockOffline(), new CodeTaken({ code: "1234" })];
    for (const spec of [Keypad.ops.setCode, UnionKeypad.ops.setCode]) {
      const is = Schema.is(errorSchema(spec));
      expect(declared.map((error) => is(error))).toEqual([true, true]);
      expect(is(new LockJammed())).toBe(false);
    }
    expect(Schema.is(errorSchema({}))(new LockOffline())).toBe(false);
  });

  it.effect("a real call fails with either declared error", () =>
    Story.make(Doors, { layer: SetCodeOnLockLive })(
      Story.when(new RequestCode({ id: d1.id, code: "0000" })),
      Story.call(Keypad.setCode, { code: "0000" }),
      Story.failed(Keypad.setCode, new CodeTaken({ code: "0000" })),
      Story.then(
        d1,
        new CodeRequested({ code: "0000" }),
        new CodeOutcome({ outcome: "taken 0000" }),
      ),
    ).pipe(
      Effect.provide(
        Keypad.toLayer(
          Effect.succeed({
            setCode: ({ code }) =>
              code === "0000"
                ? Effect.fail(new CodeTaken({ code }))
                : Effect.fail(new LockOffline()),
          }),
        ),
      ),
    ),
  );
});

// A policy sends a command, then reads a view `atLeast` that write. The view
// applies the event in a run of its own, which a story queues behind the
// policy's run.
class Tallied extends Domain.Event("Tallied", { total: Schema.Number }) {}
class Tally extends Domain.Command("Tally", { input: { id: Schema.String }, events: [Tallied] }) {}
class Tallies extends Domain.Aggregate("Tallies", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Tally],
  keyOf: (command) => command.id,
  decide: { Tally: (tally) => [new Tallied({ total: tally.total + 1 })] },
  evolve: { Tallied: (_, e) => ({ total: e.total }) },
}) {}
class TallyTotals extends Domain.View("TallyTotals", {
  from: [Tallies],
  key: Tallies,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Tallied: (_, e) => ({ total: e.total }) },
}) {}
class OrderPlaced extends Domain.Event("OrderPlaced") {}
class OrderCounted extends Domain.Event("OrderCounted", { total: Schema.Number }) {}
class PlaceOrder extends Domain.Command("PlaceOrder", {
  input: { id: Schema.String },
  events: [OrderPlaced],
}) {}
class RecordCount extends Domain.Command("RecordCount", {
  input: { id: Schema.String, total: Schema.Number },
  events: [OrderCounted],
}) {}
class Order extends Domain.Aggregate("Order", {
  id: Schema.String,
  state: Schema.Struct({ counted: Schema.Number }),
  initial: { counted: 0 },
  commands: [PlaceOrder, RecordCount],
  keyOf: (command) => command.id,
  decide: {
    PlaceOrder: () => [new OrderPlaced()],
    RecordCount: (_, cmd) => [new OrderCounted({ total: cmd.total })],
  },
  evolve: {
    OrderPlaced: (order) => order,
    OrderCounted: (_, e) => ({ counted: e.total }),
  },
}) {}
const orderTally = Tallies.ref("orders");
// Counts each order, and records on the order the total the view then shows.
class CountOrders extends Domain.Policy("CountOrders", { from: Order, on: [OrderPlaced] }) {}
const CountOrdersLive = CountOrders.toLayer(
  Effect.gen(function* () {
    const tallies = yield* Tallies;
    const orders = yield* Order;
    const totals = yield* TallyTotals;
    return Effect.fn(function* ({ source }) {
      const receipt = yield* tallies.send(new Tally({ id: orderTally.id }));
      const read = yield* totals
        .get(orderTally, { atLeast: { stream: receipt.stream, version: receipt.version } })
        .pipe(Effect.orDie);
      yield* orders.send(new RecordCount({ id: source.id, total: Option.getOrThrow(read).total }));
    });
  }),
);
class Shop extends Domain.Model("Shop", {
  aggregates: [Tallies, Order],
  views: [TallyTotals],
  policies: [CountOrders],
}) {}

// A policy stops every item of a closed box at once.
class BoxClosed extends Domain.Event("BoxClosed", { items: Schema.Array(Schema.String) }) {}
class CloseBox extends Domain.Command("CloseBox", {
  input: { id: Schema.String, items: Schema.Array(Schema.String) },
  events: [BoxClosed],
}) {}
class Box extends Domain.Aggregate("Box", {
  id: Schema.String,
  state: Schema.Struct({ closed: Schema.Boolean }),
  initial: { closed: false },
  commands: [CloseBox],
  keyOf: (command) => command.id,
  decide: { CloseBox: (_, cmd) => [new BoxClosed({ items: cmd.items })] },
  evolve: { BoxClosed: () => ({ closed: true }) },
}) {}
class ItemWorker extends Domain.ExternalSystem("ItemWorker", {
  stop: { args: { item: Schema.String } },
}) {}
class StopItems extends Domain.Policy("StopItems", { from: Box, on: [BoxClosed] }) {}
const StopItemsLive = StopItems.toLayer(
  Effect.gen(function* () {
    const worker = yield* ItemWorker;
    return Effect.fn(function* ({ event }) {
      yield* Effect.forEach(event.items, (item) => worker.stop({ item }), {
        concurrency: "unbounded",
      });
    });
  }),
);
class Boxes extends Domain.Model("Boxes", { aggregates: [Box], policies: [StopItems] }) {}

// A saga asks a remote system, and the policy that starts it may signal it
// while it waits for the answer.
class ProbeStarted extends Domain.Event("ProbeStarted", { signal: Schema.Boolean }) {}
class StartProbe extends Domain.Command("StartProbe", {
  input: { id: Schema.String, signal: Schema.Boolean },
  events: [ProbeStarted],
}) {}
class Probe extends Domain.Aggregate("Probe", {
  id: Schema.String,
  state: Schema.Struct({ started: Schema.Boolean }),
  initial: { started: false },
  commands: [StartProbe],
  keyOf: (command) => command.id,
  decide: { StartProbe: (_, cmd) => [new ProbeStarted({ signal: cmd.signal })] },
  evolve: { ProbeStarted: () => ({ started: true }) },
}) {}
class Remote extends Domain.ExternalSystem("Remote", {
  ask: { args: { id: Schema.String }, success: { ok: Schema.Boolean } },
}) {}
const poke = DurableDeferred.make("poke", { success: Schema.Void, error: Schema.Never });
class ProbeRun extends Domain.Saga("ProbeRun", { key: Schema.String, input: {} }) {}
class StartProbeRun extends Domain.Policy("StartProbeRun", { from: Probe, on: [ProbeStarted] }) {}
const ProbeHandlers = Layer.mergeAll(
  StartProbeRun.toLayer(
    Effect.gen(function* () {
      const runs = yield* ProbeRun;
      return Effect.fn(function* ({ source, event }) {
        const run = yield* runs.start(source.id, {});
        if (event.signal) yield* run.signal(poke, undefined);
      });
    }),
  ),
  ProbeRun.toLayer(
    Effect.gen(function* () {
      const remote = yield* Remote;
      return Effect.fn(function* ({ key }) {
        yield* Activity.make({
          name: "ask",
          success: Schema.Boolean,
          error: Schema.Never,
          execute: remote.ask({ id: key }).pipe(Effect.map((answer) => answer.ok)),
        });
      });
    }),
  ),
);
class Probes extends Domain.Model("Probes", {
  aggregates: [Probe],
  policies: [StartProbeRun],
  sagas: [ProbeRun],
}) {}

// A saga asks two questions at once.
class AskBoth extends Domain.Saga("AskBoth", { key: Schema.String, input: {} }) {}
class StartAskBoth extends Domain.Policy("StartAskBoth", { from: Probe, on: [ProbeStarted] }) {}
const AskBothHandlers = Layer.mergeAll(
  StartAskBoth.toLayer(
    Effect.gen(function* () {
      const runs = yield* AskBoth;
      return Effect.fn(function* ({ source }) {
        yield* runs.start(source.id, {});
      });
    }),
  ),
  AskBoth.toLayer(
    Effect.gen(function* () {
      const remote = yield* Remote;
      return Effect.fn(function* ({ key }) {
        yield* Effect.forEach(
          ["x", "y"],
          (part) =>
            Activity.make({
              name: `ask ${part}`,
              success: Schema.Boolean,
              error: Schema.Never,
              execute: remote.ask({ id: `${key}/${part}` }).pipe(Effect.map((a) => a.ok)),
            }),
          { concurrency: "unbounded" },
        );
      });
    }),
  ),
);
class Pairs extends Domain.Model("Pairs", {
  aggregates: [Probe],
  policies: [StartAskBoth],
  sagas: [AskBoth],
}) {}

describe("Domain Story: runs that wait", { tags: ["unit", "local"] }, () => {
  it.effect(
    "a policy reads a view at least at the write it sent",
    () =>
      Story.make(Shop, { layer: CountOrdersLive })(
        Story.when(new PlaceOrder({ id: Order.ref("o-1").id })),
        Story.then(Order.ref("o-1"), new OrderPlaced()),
        Story.then(orderTally, new Tallied({ total: 1 })),
        Story.then(Order.ref("o-1"), new OrderCounted({ total: 1 })),
        Story.view(TallyTotals, orderTally, { total: 1 }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "a policy waits on several calls at once",
    () =>
      Story.make(Boxes, { layer: StopItemsLive, stub: [ItemWorker] })(
        Story.when(new CloseBox({ id: Box.ref("b-1").id, items: ["a", "b"] })),
        Story.then(Box.ref("b-1"), new BoxClosed({ items: ["a", "b"] })),
        Story.call("a", ItemWorker.stop, { item: "a" }),
        Story.call("b", ItemWorker.stop, { item: "b" }),
        Story.succeed("a", ItemWorker.stop, undefined),
        Story.succeed("b", ItemWorker.stop, undefined),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "a saga runs two activities at once",
    () =>
      Story.make(Pairs, { layer: AskBothHandlers, stub: [Remote] })(
        Story.when(new StartProbe({ id: Probe.ref("p-2").id, signal: false })),
        Story.then(Probe.ref("p-2"), new ProbeStarted({ signal: false })),
        Story.call("x", Remote.ask, { id: "p-2/x" }),
        Story.call("y", Remote.ask, { id: "p-2/y" }),
        Story.succeed("x", Remote.ask, { ok: true }),
        Story.succeed("y", Remote.ask, { ok: true }),
        Story.saga(AskBoth, "p-2", { _tag: "Completed", result: undefined }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "a saga is signalled while it waits on a call",
    () =>
      Story.make(Probes, { layer: ProbeHandlers, stub: [Remote] })(
        Story.when(new StartProbe({ id: Probe.ref("p-1").id, signal: true })),
        Story.then(Probe.ref("p-1"), new ProbeStarted({ signal: true })),
        Story.call(Remote.ask, { id: "p-1" }),
        Story.succeed(Remote.ask, { ok: true }),
        Story.saga(ProbeRun, "p-1", { _tag: "Completed", result: undefined }),
      ),
    { timeout: 30_000 },
  );
});
