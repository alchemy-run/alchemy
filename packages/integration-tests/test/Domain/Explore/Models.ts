/** Tiny models for the self-tests: known state counts and known bugs. */
import * as Domain from "@alchemy.run/domain";
import {
  choose as chooseOf,
  fakeState,
  ruleFails,
  send,
  spend,
  type Actor,
  type Rule,
  type Scenario,
} from "@alchemy.run/domain/Explore";
import { Story } from "@alchemy.run/domain/Story";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

// ─────────────────────────────────────────────── Fake-only scenarios ──

/** A model with no aggregate work, for scenarios whose state is a fake. */
class Nop extends Domain.Event("Nop", {}) {}
class Ping extends Domain.Command("Ping", { target: Schema.String, input: {}, events: [Nop] }) {}
export class Dummy extends Domain.Aggregate("Dummy", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Number }),
  initial: { n: 0 },
  commands: [Ping],
  decide: { Ping: () => [new Nop({})] },
  evolve: { Nop: (s) => ({ n: s.n + 1 }) },
}) {}
export class DummyModel extends Domain.Model("DummyModel", { aggregates: [Dummy] }) {}

const fakeScenario = (
  name: string,
  actors: ReadonlyArray<Actor>,
  rules: ReadonlyArray<Rule>,
  extra: Partial<Scenario> = {},
): Scenario => ({
  name,
  model: DummyModel,
  layer: DummyModel.layer(Layer.empty),
  actors,
  fakes: [{ name: "g", initial: () => ({}) }],
  rules,
  bounds: { depth: 10 },
  startTimeMillis: T0,
  derived: { timerRearm: false },
  ...extra,
});

const g = () => fakeState<Record<string, unknown>>("g");

/** Two one-shot independent bits: 4 states, 4 transitions. */
export const twoBits = fakeScenario(
  "twoBits",
  ["a", "b"].map((k) => ({
    key: k,
    enabled: (s) => !s.fake("g")[k],
    run: () => Effect.sync(() => void (g()[k] = true)),
  })),
  [],
);

/** A finite three-value choice: 3 leaves. A conditional 2-then-(3|2) choice: 5 leaves. */
export const choices = fakeScenario(
  "choices",
  [
    {
      key: "three",
      enabled: (s) => s.fake("g").v === undefined,
      run: () => Effect.sync(() => void (g().v = chooseOf("v", ["0", "1", "2"]))),
    },
    {
      key: "nested",
      enabled: (s) => s.fake("g").w === undefined,
      run: () =>
        Effect.sync(() => {
          const first = chooseOf("first", ["x", "y"]);
          g().w = first + chooseOf("second", first === "x" ? ["0", "1", "2"] : ["0", "1"]);
        }),
    },
  ],
  [],
);

/** root→p→r→x→bad and root→q→x→bad: `bad` sits at depth 3. */
export const depthGraph = fakeScenario(
  "depthGraph",
  (
    [
      ["root", "p"],
      ["root", "q"],
      ["p", "r"],
      ["r", "x"],
      ["q", "x"],
      ["x", "bad"],
    ] as const
  ).map(([from, to]) => ({
    key: `${from}-${to}`,
    enabled: (s) => s.fake("g").node === from,
    run: () => Effect.sync(() => void (g().node = to)),
  })),
  [
    {
      id: "BAD",
      kind: "state",
      check: (s) => (s.fake("g").node === "bad" ? "reached bad" : undefined),
    },
  ],
  { fakes: [{ name: "g", initial: () => ({ node: "root" }) }], bounds: { depth: 3 } },
);

/** An invalid root with no moves must still be reported. */
export const badRoot = fakeScenario(
  "badRoot",
  [],
  [{ id: "ROOT", kind: "state", check: () => "the root is invalid" }],
);

/** Engine errors: an async effect, a Clock.sleep, a hidden random id. */
export const asyncActor = fakeScenario(
  "asyncActor",
  [{ key: "p", run: () => Effect.promise(() => Promise.resolve(1)) }],
  [],
);
export const sleepActor = fakeScenario(
  "sleepActor",
  [{ key: "s", run: () => Effect.sleep("1 second") }],
  [],
);
export const randomActor = fakeScenario(
  "randomActor",
  [
    {
      key: "r",
      enabled: (s) => !s.fake("g").r,
      run: () => Effect.sync(() => void (g().r = crypto.randomUUID())),
    },
  ],
  [],
);
export const dateActor = fakeScenario(
  "dateActor",
  [{ key: "d", run: () => Effect.sync(() => void (g().d = new Date(0))) }],
  [],
);

// ─────────────────────────────────────────────────── The timer model ──

class Armed extends Domain.Event("Armed", { deadline: Schema.Number }) {}
class Frozen extends Domain.Event("Frozen", {}) {}
class Unfrozen extends Domain.Event("Unfrozen", {}) {}
class Fired extends Domain.Event("Fired", { deadline: Schema.Number }) {}
class LateDone extends Domain.Event("LateDone", {}) {}

export class Arm extends Domain.Command("Arm", {
  target: Schema.String,
  input: { deadline: Schema.Number },
  events: [Armed],
}) {}
class Freeze extends Domain.Command("Freeze", {
  target: Schema.String,
  input: {},
  events: [Frozen],
}) {}
/** The unfreeze arms the same deadline again. */
class Unfreeze extends Domain.Command("Unfreeze", {
  target: Schema.String,
  input: {},
  events: [Unfrozen, Armed],
}) {}
export class Fire extends Domain.Command("Fire", {
  target: Schema.String,
  input: { deadline: Schema.Number },
  events: [Fired],
}) {}
class ActLate extends Domain.Command("ActLate", {
  target: Schema.String,
  input: {},
  events: [LateDone],
}) {}

const JobState = Schema.Struct({
  deadline: Schema.NullOr(Schema.Number),
  frozen: Schema.Boolean,
  fired: Schema.Boolean,
  late: Schema.Boolean,
});

export class Job extends Domain.Aggregate("Job", {
  id: Schema.String,
  state: JobState,
  initial: { deadline: null, frozen: false, fired: false, late: false },
  commands: [Arm, Freeze, Unfreeze, Fire, ActLate],
  decide: {
    Arm: (_s, c) => [new Armed({ deadline: c.deadline })],
    Freeze: (s) => (s.frozen ? [] : [new Frozen({})]),
    Unfreeze: (s) =>
      s.frozen && s.deadline !== null
        ? [new Unfrozen({}), new Armed({ deadline: s.deadline })]
        : [],
    // Stale (frozen, or another deadline): records nothing.
    Fire: (s, c) =>
      s.frozen || s.fired || s.deadline !== c.deadline ? [] : [new Fired({ deadline: c.deadline })],
    ActLate: (s, _c, { now }) =>
      s.deadline !== null && !s.fired && DateTime.toEpochMillis(now) >= s.deadline
        ? [new LateDone({})]
        : [],
  },
  evolve: {
    Armed: (s, e) => ({ ...s, deadline: e.deadline }),
    Frozen: (s) => ({ ...s, frozen: true }),
    Unfrozen: (s) => ({ ...s, frozen: false }),
    Fired: (s) => ({ ...s, fired: true }),
    LateDone: (s) => ({ ...s, late: true }),
  },
}) {}

/** The bug: a deterministic timer id, and a swallowed AlreadyExecuted. */
export class JobTimers extends Domain.Policy("JobTimers", { from: Job, key: Job, on: [Armed] }) {}
export const JobTimersLive = JobTimers.toLayer(
  Effect.gen(function* () {
    const jobs = yield* Job;
    return Effect.fn(function* ({ source, event }) {
      yield* jobs
        .schedule(source.id, new Fire({ deadline: event.deadline }), {
          at: DateTime.makeUnsafe(event.deadline),
          commandId: `fire:${source.id}:${event.deadline}`,
        })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);

export class JobModel extends Domain.Model("JobModel", {
  aggregates: [Job],
  policies: [JobTimers],
}) {}

const jobActor = (
  key: string,
  id: string,
  make: () => Domain.Aggregate.CommandOf<typeof Job>,
  enabled: (s: any) => boolean,
): Actor => ({
  key: `${key}@${id}`,
  enabled: (snap) => snap.budget(`n:${key}:${id}`) > 0 && enabled(snap.state("Job", id)),
  run: (ctx) =>
    Effect.gen(function* () {
      spend(`n:${key}:${id}`);
      yield* send(ctx, Job, id, make(), { commandId: `api:${key}:${id}` });
    }),
});

export const jobScenario = (
  o: {
    ids?: ReadonlyArray<string>;
    freeze?: boolean;
    redeliveries?: number;
    ticks?: number;
    late?: boolean;
    rules?: ReadonlyArray<Rule>;
  } = {},
): Scenario => {
  const ids = o.ids ?? ["J1"];
  const actors: Array<Actor> = [];
  const budgets: Record<string, number> = {};
  for (const id of ids) {
    actors.push(
      jobActor(
        "arm",
        id,
        () => new Arm({ deadline: T0 + 24 * HOUR }),
        (s) => s === undefined,
      ),
    );
    budgets[`n:arm:${id}`] = 1;
    if (o.freeze !== false) {
      actors.push(
        jobActor(
          "freeze",
          id,
          () => new Freeze({}),
          (s) => s !== undefined && !s.frozen,
        ),
      );
      actors.push(
        jobActor(
          "unfreeze",
          id,
          () => new Unfreeze({}),
          (s) => s !== undefined && s.frozen,
        ),
      );
      budgets[`n:freeze:${id}`] = 1;
      budgets[`n:unfreeze:${id}`] = 1;
    }
    if (o.late) {
      actors.push(
        jobActor(
          "late",
          id,
          () => new ActLate({}),
          (s) => s !== undefined && !s.late,
        ),
      );
      budgets[`n:late:${id}`] = 1;
    }
  }
  return {
    name: `job(${ids.join(",")}${o.freeze === false ? ",nofreeze" : ""}${o.redeliveries ? `,red${o.redeliveries}` : ""}${o.ticks ? `,ticks${o.ticks}` : ""}${o.late ? ",late" : ""})`,
    model: JobModel,
    layer: JobModel.layer(JobTimersLive),
    actors,
    fakes: [],
    rules: o.rules ?? [],
    bounds: {
      actorSteps: 6,
      depth: 20,
      redeliveries: o.redeliveries ?? 0,
      ticks: o.ticks ?? 0,
      budgets,
    },
    startTimeMillis: T0,
  };
};

/** A business rule over the timer model: an unfrozen, unfired job has its Fire timer armed (by command, not by id format). */
export const JOB_ARMED: Rule = {
  id: "JOB-ARMED",
  kind: "quiescent",
  check: (s) => {
    for (const [id, st] of s.instances("Job"))
      if (
        st.deadline !== null &&
        !st.frozen &&
        !st.fired &&
        s.timers({ agg: "Job", id, command: "Fire" }).length === 0
      )
        return `${id}: not fired, no Fire timer`;
    return undefined;
  },
};

/** JOB-ARMED with a Story tail: two days later the job has fired. */
export const JOB_ARMED_TAIL: Rule = {
  ...JOB_ARMED,
  storyTail: () => ({
    code: [`    Story.clock("2030-01-03T00:00:00.000Z"),`],
    steps: [
      Story.clock("2030-01-03T00:00:00.000Z"),
      Story.state(Job.ref("J1"), (s) => {
        if (!s.fired) throw new Error(ruleFails("JOB-ARMED"));
      }),
    ],
  }),
};

export const jobStoryBindings = {
  ref: (a: string, id: string) => `${a}.ref(${JSON.stringify(id)})`,
  header: () => "",
  aggregate: () => Job,
  run: (steps: ReadonlyArray<unknown>) =>
    (Story.make as any)(JobModel, { layer: JobTimersLive })(...steps) as Effect.Effect<
      void,
      unknown
    >,
};

export const LATE_RULE: Rule = {
  id: "ACTED-LATE",
  kind: "state",
  check: (s) =>
    s.instances("Job").some(([, st]) => st.late)
      ? "an actor acted after the deadline, before the fire"
      : undefined,
};

// ─────────────────────────────────────────────── Two sends, one run ──

export class Go extends Domain.Event("Go", {}) {}
class Hit extends Domain.Event("Hit", {}) {}
export class Start extends Domain.Command("Start", {
  target: Schema.String,
  input: {},
  events: [Go],
}) {}
class Mark extends Domain.Command("Mark", { target: Schema.String, input: {}, events: [Hit] }) {}

export class Src extends Domain.Aggregate("Src", {
  id: Schema.String,
  state: Schema.Struct({ started: Schema.Boolean }),
  initial: { started: false },
  commands: [Start],
  decide: { Start: (s) => (s.started ? [] : [new Go({})]) },
  evolve: { Go: () => ({ started: true }) },
}) {}
export class Sink extends Domain.Aggregate("Sink", {
  id: Schema.String,
  state: Schema.Struct({ hits: Schema.Number }),
  initial: { hits: 0 },
  commands: [Mark],
  decide: { Mark: () => [new Hit({})] },
  evolve: { Hit: (s) => ({ hits: s.hits + 1 }) },
}) {}

/** One run, two sends: Sink/x then Sink/y. */
export class TwoSends extends Domain.Policy("TwoSends", { from: Src, key: Src, on: [Go] }) {}
export const TwoSendsLive = TwoSends.toLayer(
  Effect.gen(function* () {
    const sinks = yield* Sink;
    return Effect.fn(function* ({ source }) {
      yield* sinks.send("x", new Mark({}), { commandId: `mark:x:${source.id}` });
      yield* sinks.send("y", new Mark({}), { commandId: `mark:y:${source.id}` });
    });
  }),
);
export class TwoModel extends Domain.Model("TwoModel", {
  aggregates: [Src, Sink],
  policies: [TwoSends],
}) {}

export const twoSends = (policyFaults: boolean): Scenario => ({
  name: `twoSends(${policyFaults})`,
  model: TwoModel,
  layer: TwoModel.layer(TwoSendsLive),
  actors: [
    {
      key: "start",
      enabled: (s) => s.state("Src", "s") === undefined,
      run: (ctx) => send(ctx, Src, "s", new Start({}), { commandId: "api:start" }),
    },
  ],
  fakes: [],
  rules: [
    {
      id: "HALF-DONE",
      kind: "state",
      check: (s) =>
        s.state("Sink", "x")?.hits === 1 &&
        s.state("Sink", "y") === undefined &&
        s.work().some((w) => w.tries > 0)
          ? "x marked, y not, the run will be retried"
          : undefined,
    },
  ],
  bounds: { actorSteps: 1, depth: 10, faults: 1 },
  startTimeMillis: T0,
  host: { faultable: ({ by }) => policyFaults && by.kind === "policy" },
});

// ─────────────────────────────────────────── Hidden state in a layer ──

let counter = 0;
/** A policy whose command ids come from a counter in its layer: hidden state. */
export class Leaky extends Domain.Policy("Leaky", { from: Src, key: Src, on: [Go] }) {}
export const LeakyLive = Leaky.toLayer(
  Effect.gen(function* () {
    const sinks = yield* Sink;
    return Effect.fn(function* () {
      yield* sinks.send("x", new Mark({}), { commandId: `leak:${counter++}` });
    });
  }),
);
export class LeakyModel extends Domain.Model("LeakyModel", {
  aggregates: [Src, Sink],
  policies: [Leaky],
}) {}
export const leaky: Scenario = {
  name: "leaky",
  model: LeakyModel,
  layer: LeakyModel.layer(LeakyLive),
  actors: ["s1", "s2"].map((id) => ({
    key: id,
    enabled: (s) => s.state("Src", id) === undefined,
    run: (ctx) => send(ctx, Src, id, new Start({}), { commandId: `api:${id}` }),
  })),
  fakes: [],
  rules: [],
  bounds: { actorSteps: 2, depth: 10 },
  startTimeMillis: T0,
};

// ───────────────────────────────────────────── A deliberate die ──

export class Refused extends Domain.Rejection("Refused", {}) {}
export class Dying extends Domain.Policy("Dying", { from: Src, key: Src, on: [Go] }) {}
export const DyingLive = Dying.toLayer(
  Effect.succeed(
    Effect.fn(function* () {
      return yield* Effect.die(new Refused({}));
    }),
  ),
);
export class DyingModel extends Domain.Model("DyingModel", {
  aggregates: [Src],
  policies: [Dying],
}) {}
export const dyingPolicy = (retryDefects: ReadonlyArray<string>): Scenario => ({
  name: `dying(${retryDefects.join()})`,
  model: DyingModel,
  layer: DyingModel.layer(DyingLive),
  actors: [
    {
      key: "start",
      enabled: (s) => s.state("Src", "s") === undefined,
      run: (ctx) => send(ctx, Src, "s", new Start({}), { commandId: "api:start" }),
    },
  ],
  fakes: [],
  rules: [],
  bounds: { actorSteps: 1, depth: 10 },
  startTimeMillis: T0,
  host: { retryDefects },
});
