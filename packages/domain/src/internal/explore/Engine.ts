/**
 * The step engine: the scenario contract, the moves a world can take, the
 * choice tree of one move, the rules and the canonical state. It holds no app
 * knowledge; a scenario gives the model, the fakes, the actors and the rules.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import type * as Aggregate from "../../Aggregate.ts";
import type * as Model from "../../Model.ts";
import { Platform, type Json, type ViewSnapshot } from "../../Platform.ts";
import { canonical, digest, type Digest } from "./Canonical.ts";
import { EngineFault, type EngineError } from "./Errors.ts";
import {
  byText,
  classify,
  runningRt as activeRt,
  emptyLog,
  engineErrorOf,
  errorText,
  explorePlatform,
  partitionKey,
  Rt,
  sandboxed,
  splitPartition,
  withActive,
  worldClock,
  type By,
  type Call,
  type Commit,
  type Dead,
  type HostProfile,
  type Provided,
  type ScriptEntry,
  type Send,
  type StepLog,
  type TimerRec,
  type World,
} from "./Host.ts";

// ───────────────────────────────────────────────────────── Snapshot ──

export interface TimerView {
  readonly key: string;
  readonly agg: string;
  readonly id: string;
  readonly commandId: string;
  readonly command: Json;
  readonly at: number;
}

export interface WorkView {
  readonly partition: string;
  readonly kind: "policy" | "view" | "projection";
  readonly target: string;
  readonly key: string;
  readonly tag: string;
  readonly source: string;
  readonly seq: number;
  readonly tries: number;
}

/**
 * The read side of a world for rules and actor guards.
 */
export class Snapshot {
  readonly world: World;
  private readonly abstractViews: ReadonlySet<string>;

  constructor(world: World, abstractViews: ReadonlySet<string>) {
    this.world = world;
    this.abstractViews = abstractViews;
  }

  get clock() {
    return this.world.clock;
  }

  /** One instance's encoded state, or undefined when it never committed. */
  state(agg: string, id: string): any {
    const i = this.world.aggs[agg]?.[id];
    return i && i.version > 0 ? i.state : undefined;
  }

  version(agg: string, id: string): number {
    return this.world.aggs[agg]?.[id]?.version ?? 0;
  }

  /** Every instance of an aggregate that committed, as `[id, state]`. */
  instances(agg: string): Array<[string, any]> {
    return Object.entries(this.world.aggs[agg] ?? {})
      .filter(([, i]) => i.version > 0)
      .map(([id, i]) => [id, i.state]);
  }

  /** Armed timers, filtered by aggregate, id and command tag. */
  timers(
    filter: { readonly agg?: string; readonly id?: string; readonly command?: string } = {},
  ): Array<TimerView> {
    return Object.entries(this.world.timers)
      .filter(
        ([, t]) =>
          (filter.agg === undefined || t.agg === filter.agg) &&
          (filter.id === undefined || t.id === filter.id) &&
          (filter.command === undefined ||
            (t.command as { _tag?: string })?._tag === filter.command),
      )
      .map(([key, t]) => ({
        key,
        agg: t.agg,
        id: t.id,
        commandId: t.meta.commandId,
        command: t.command,
        at: t.at,
      }));
  }

  work(): Array<WorkView> {
    const out: Array<WorkView> = [];
    for (const [pk, items] of Object.entries(this.world.work)) {
      const p = splitPartition(pk);
      for (const q of items)
        out.push({
          partition: pk,
          ...p,
          tag: q.d.tag,
          source: q.d.source,
          seq: q.d.seq,
          tries: q.tries,
        });
    }
    for (const [name, keys] of Object.entries(this.world.proj))
      for (const [key, part] of Object.entries(keys))
        for (const a of part.pending)
          out.push({
            partition: partitionKey("projection", name, key),
            kind: "projection",
            target: name,
            key,
            tag: a.delivery.tag,
            source: a.delivery.source,
            seq: a.delivery.seq,
            tries: part.tries,
          });
    return out;
  }

  dead(): ReadonlyArray<Dead> {
    return this.world.dead;
  }

  fake<S = any>(name: string): S {
    return this.world.ext[name] as S;
  }

  budget(name: string): number {
    return this.world.budget[name] ?? 0;
  }

  view(name: string, key: string): ViewSnapshot | undefined {
    if (this.abstractViews.has(name))
      throw new EngineFault("Unsupported", `a rule read the abstract view ${name}`);
    return this.world.views[name]?.[key]?.snapshot;
  }

  /** No runnable internal work: no work item, no due timer, no unprocessed projection input. */
  get quiescent(): boolean {
    return isQuiescent(this.world);
  }
}

export const isQuiescent = (w: World) => {
  for (const items of Object.values(w.work)) if (items.length > 0) return false;
  for (const t of Object.values(w.timers)) if (t.at <= w.clock) return false;
  for (const keys of Object.values(w.proj))
    for (const p of Object.values(keys)) if (!p.stuck && p.pending.length > 0) return false;
  return true;
};

// ─────────────────────────────────────────────────────── Scenario ──

/** An actor: a stable key, an observable guard, and the sends it makes. */
export interface Actor {
  readonly key: string;
  readonly label?: string;
  /** Absent: always enabled . */
  readonly enabled?: (s: Snapshot) => boolean;
  readonly run: (ctx: Context.Context<any>) => Effect.Effect<unknown, unknown>;
}

/** A fake external system or store: its state lives in the world (plain JSON). */
export interface Fake {
  readonly name: string;
  readonly initial: () => Json;
}

export interface Step {
  readonly move: { readonly kind: MoveKind; readonly key: string; readonly label: string };
  readonly commits: ReadonlyArray<Commit>;
  readonly rejections: StepLog["rejections"];
  readonly calls: ReadonlyArray<Call>;
  readonly failures: StepLog["failures"];
  readonly defects: StepLog["defects"];
  readonly sends: ReadonlyArray<Send>;
  readonly refusedSchedules: StepLog["refusedSchedules"];
  readonly ok: boolean;
}

/**
 * What must be witnessed for a rule's verdict to mean anything: a state or a
 * step. A rule whose trigger never fires in a run is VACUOUS, not held.
 */
export interface Reachable {
  readonly text: string;
  readonly state?: (s: Snapshot) => boolean;
  readonly step?: (s: Snapshot, step: Step) => boolean;
}

interface RuleBase {
  readonly id: string;
  readonly text?: string;
  readonly source?: string;
  /** The trigger of this rule. Absent: the report says the rule names none. */
  readonly reachable?: Reachable;
  /** Assumption ids the verdict rests on (the report lists who checks each). */
  readonly assumes?: ReadonlyArray<string>;
  /**
   * What the Story adds after the trace: the same steps as code and as real
   * Story steps. It must throw `ruleFails(id)` when the rule breaks.
   */
  readonly storyTail?: (v: { readonly message: string; readonly world: World }) => {
    readonly code: ReadonlyArray<string>;
    readonly steps: ReadonlyArray<unknown>;
  };
}

export type Rule = RuleBase &
  (
    | { readonly kind: "state"; readonly check: (s: Snapshot) => string | undefined }
    | { readonly kind: "step"; readonly check: (s: Snapshot, step: Step) => string | undefined }
    | { readonly kind: "quiescent"; readonly check: (s: Snapshot) => string | undefined }
    | {
        readonly kind: "eventually";
        /** At a quiescent state where `when` holds, run timers and work only (no actor, no fault) for `horizonMillis`, then check `goal`. */
        readonly when: (s: Snapshot) => boolean;
        readonly horizonMillis: number;
        readonly goal: (s: Snapshot) => string | undefined;
      }
  );

export interface Bounds {
  /** Actor moves on one path (budget `actors`); absent: no actor limit (the depth bounds the path). */
  readonly actorSteps?: number;
  readonly depth: number;
  /** Redeliveries of a delivered item (budget `redeliveries`). */
  readonly redeliveries?: number;
  /** Host faults on faultable sends (budget `faults`). */
  readonly faults?: number;
  /** Clock moves without a fire (budget `ticks`): to the next timer, and by each of `clockSteps`. */
  readonly ticks?: number;
  readonly clockSteps?: ReadonlyArray<number>;
  /** The scenario's own budgets (pool counts, fake faults). */
  readonly budgets?: Readonly<Record<string, number>>;
}

export interface Limits {
  readonly states?: number;
  readonly elapsedMillis?: number;
  readonly memoryBytes?: number;
}

/** Any Model class. `sagas` is on the class, not on its type. */
export type ModelLike = Model.Any & { readonly sagas?: ReadonlyArray<unknown> };

export interface Scenario {
  readonly name: string;
  readonly model: ModelLike;
  /** `Model.layer(handlers)` with the fakes provided; it needs only `Platform`. */
  readonly layer: Layer.Layer<any, any, Platform>;
  readonly actors: ReadonlyArray<Actor>;
  readonly fakes: ReadonlyArray<Fake>;
  readonly rules: ReadonlyArray<Rule>;
  readonly bounds: Bounds;
  readonly startTimeMillis: number;
  readonly host?: HostProfile;
  /** Derived rules, all on by default. */
  readonly derived?: {
    readonly defect?: boolean;
    readonly deadLetter?: boolean;
    readonly timerRearm?: boolean;
  };
  /** Plain data the report keeps (assumptions, notes). */
  readonly notes?: ReadonlyArray<string>;
}

// ──────────────────────────────────────────────────── Derived rules ──

export const DERIVED: ReadonlyArray<Rule> = [
  {
    id: "DEFECT",
    text: "DERIVED: no command, policy, view or projection dies of a model defect (an evolve guard, a bug).",
    source: "engine: a die that is not a host fault",
    kind: "step",
    check: (_s, step) =>
      step.defects[0] ? `${step.defects[0].where}: ${step.defects[0].error}` : undefined,
  },
  {
    id: "DEAD-LETTER",
    text: "DERIVED: no delivery fails for good (after maxTries).",
    source: "engine: the host profile's maxTries",
    kind: "state",
    check: (s) => {
      const d = s.dead()[0];
      return d ? `${d.kind} ${d.target} on ${d.tag} (${d.source}#${d.seq}): ${d.error}` : undefined;
    },
  },
  {
    id: "TIMER-REARM",
    text: "DERIVED: a new input asked to schedule a command that had already run stale (no events) BEFORE that input committed, and went on: the command will never run for it.",
    source:
      "engine: schedule() answered AlreadyExecuted to an input of the same stream that did not arm it, the command had run stale before that input, and the run succeeded",
    reachable: {
      text: "a schedule() answered AlreadyExecuted",
      step: (_s, step) => step.refusedSchedules.length > 0,
    },
    kind: "step",
    check: (_s, step) => {
      if (!step.ok) return undefined;
      const r = step.refusedSchedules.find(
        (x) => x.sameStream && x.stale && !x.repeat && !x.served,
      );
      return r
        ? `${r.agg}/${r.id}: schedule(${r.commandId}) by ${r.input} answered AlreadyExecuted and was swallowed`
        : undefined;
    },
  },
];

export const rulesOf = (scenario: Scenario): ReadonlyArray<Rule> => {
  const d = scenario.derived ?? {};
  return [
    ...DERIVED.filter((r) =>
      r.id === "DEFECT"
        ? d.defect !== false
        : r.id === "DEAD-LETTER"
          ? d.deadLetter !== false
          : d.timerRearm !== false,
    ),
    ...scenario.rules,
  ];
};

// ───────────────────────────────────────────────────────── Build ──

export interface Built {
  readonly rt: Rt;
  readonly ctx: Context.Context<any>;
  readonly scenario: Scenario;
  readonly rules: ReadonlyArray<Rule>;
  readonly abstractViews: ReadonlySet<string>;
  readonly abstractions: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

const nameOf = (x: any): string =>
  x?.aggregateName ?? x?.viewName ?? x?.policyName ?? x?.projectionName ?? "?";
const fromOf = (from: unknown): ReadonlyArray<unknown> => (Array.isArray(from) ? from : [from]);

/** Refuse what the engine does not host; list every abstraction the scenario declared. */
export const checkSetup = (
  scenario: Scenario,
): { errors: Array<string>; abstractions: Array<string>; abstractViews: Set<string> } => {
  const errors: Array<string> = [];
  const abstractions: Array<string> = [];
  const def = scenario.model.definitions;
  if (def.streams.length > 0)
    errors.push(`${def.streams.length} stream(s): streams are not explored`);
  if ((scenario.model.sagas ?? []).length > 0)
    errors.push(`${scenario.model.sagas!.length} saga(s): sagas are not explored`);
  const views = scenario.host?.views ?? {};
  const abstractViews = new Set(
    Object.entries(views)
      .filter(([, m]) => m === "abstract")
      .map(([n]) => n),
  );
  for (const v of def.views) {
    const mode = views[v.viewName] ?? "queued";
    if (mode === "abstract")
      abstractions.push(`view ${v.viewName}: not run (abstract); no rule may read it`);
    if (mode === "inline")
      abstractions.push(`view ${v.viewName}: applied in the committing step (no lag)`);
  }
  const consumers: Array<[string, ReadonlyArray<unknown>, boolean]> = [
    ...def.policies.map(
      (p) =>
        [`policy ${p.policyName}`, fromOf(p.definition.from), false] as [
          string,
          ReadonlyArray<unknown>,
          boolean,
        ],
    ),
    ...def.projections.map(
      (p) =>
        [`projection ${p.projectionName}`, fromOf(p.definition.from), false] as [
          string,
          ReadonlyArray<unknown>,
          boolean,
        ],
    ),
    ...def.views.map(
      (v) =>
        [`view ${v.viewName}`, v.definition.from, abstractViews.has(v.viewName)] as [
          string,
          ReadonlyArray<unknown>,
          boolean,
        ],
    ),
  ];
  for (const [who, from, isAbstract] of consumers)
    for (const src of from)
      if (abstractViews.has(nameOf(src)) && !isAbstract)
        errors.push(
          `${who} consumes the abstract view ${nameOf(src)}: an abstract view must feed nothing`,
        );
  for (const p of def.projections) {
    const mode = scenario.host?.projections?.[p.projectionName] ?? "queued";
    if (mode === "inline")
      abstractions.push(
        `projection ${p.projectionName}: all pending input as one batch in the committing step (no lag)`,
      );
  }
  for (const tag of scenario.host?.retryDefects ?? [])
    abstractions.push(`a die with _tag ${tag} is a modeled failure (retry), not a DEFECT`);
  for (const name of Object.keys(views))
    if (!def.views.some((v) => v.viewName === name))
      errors.push(`host.views names ${name}, not a view of the model`);
  return { errors, abstractions, abstractViews };
};

/** Build the model on a fresh explore host (one scoped runtime). */
export const build = async (scenario: Scenario): Promise<Built> => {
  const setup = checkSetup(scenario);
  if (setup.errors.length > 0) throw new EngineFault("Unsupported", setup.errors.join("; "));
  const rt = new Rt(scenario.host ?? {});
  rt.armedByOn = scenario.derived?.timerRearm !== false;
  rt.world = freshWorld(scenario);
  const scope = Effect.runSync(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  let ctx: Context.Context<any>;
  try {
    ctx = await withActive(rt, () =>
      Effect.runPromise(
        Layer.buildWithScope(
          scenario.layer.pipe(Layer.provide(Layer.succeed(Platform, explorePlatform(rt)))),
          scope,
        ).pipe(Effect.provide(quiet)),
      ),
    );
    if (rt.setup.length > 0) throw new EngineFault("Unsupported", rt.setup.join("; "));
  } catch (e) {
    await close();
    throw e;
  }
  return {
    rt,
    ctx,
    scenario,
    rules: rulesOf(scenario),
    abstractViews: setup.abstractViews,
    abstractions: setup.abstractions,
    close,
  };
};

export const freshWorld = (scenario: Scenario): World => {
  const b = scenario.bounds;
  return {
    clock: scenario.startTimeMillis,
    aggs: {},
    work: {},
    timers: {},
    views: {},
    proj: {},
    ext: Object.fromEntries(scenario.fakes.map((f) => [f.name, f.initial()])),
    delivered: {},
    dead: [],
    budget: {
      ...(b.actorSteps !== undefined ? { actors: b.actorSteps } : {}),
      redeliveries: b.redeliveries ?? 0,
      faults: b.faults ?? 0,
      ticks: b.ticks ?? 0,
      ...b.budgets,
    },
  };
};

const quiet = Logger.layer([]);

// ──────────────────────────────────────────────────────────── Moves ──

export type MoveKind = "actor" | "run" | "timer" | "tick" | "redeliver";

export interface Move {
  readonly kind: MoveKind;
  /** Stable across states: the trace key. */
  readonly key: string;
  readonly label: string;
  /** For a timer or a tick: the time the clock moves to. */
  readonly at?: number;
  readonly actor?: Actor;
}

const maxTriesOf = (b: Built) => b.scenario.host?.maxTries ?? 2;

/** The moves enabled in a world, sorted by key. */
export const enabled = (b: Built, w: World): Array<Move> => {
  const moves: Array<Move> = [];
  if (!("actors" in w.budget) || w.budget.actors! > 0)
    for (const a of b.scenario.actors) {
      const ok = a.enabled
        ? withActive(b.rt, () => a.enabled!(new Snapshot(w, b.abstractViews)))
        : true;
      if (ok)
        moves.push({ kind: "actor", key: `actor:${a.key}`, label: a.label ?? a.key, actor: a });
    }
  for (const [pk, items] of Object.entries(w.work))
    if (items.length > 0)
      moves.push({
        kind: "run",
        key: `run:${pk}`,
        label: runLabel(pk, items[0]!.d, items[0]!.tries),
      });
  for (const [name, keys] of Object.entries(w.proj))
    for (const [key, part] of Object.entries(keys))
      if (!part.stuck && part.pending.length > 0) {
        const pk = partitionKey("projection", name, key);
        moves.push({
          kind: "run",
          key: `run:${pk}`,
          label: runLabel(pk, part.pending[0]!.delivery, part.tries),
        });
      }
  if ((w.budget.redeliveries ?? 0) > 0)
    for (const [pk, q] of Object.entries(w.delivered))
      moves.push({
        kind: "redeliver",
        key: `redeliver:${pk}`,
        label: `redeliver ${runLabel(pk, q.d, 0)}`,
      });
  const timers = Object.entries(w.timers);
  const due = timers.filter(([, t]) => t.at <= w.clock);
  const future = timers.filter(([, t]) => t.at > w.clock);
  const next = future.length > 0 ? Math.min(...future.map(([, t]) => t.at)) : undefined;
  // Due timers fire in any order; with none due, the earliest future ones fire (the clock jumps).
  for (const [key, t] of due.length > 0 ? due : future.filter(([, t]) => t.at === next))
    moves.push({
      kind: "timer",
      key: `timer:${key}`,
      label: timerLabel(b, w, t),
      at: Math.max(t.at, w.clock),
    });
  if ((w.budget.ticks ?? 0) > 0) {
    if (next !== undefined)
      moves.push({
        kind: "tick",
        key: "tick:next",
        label: `tick to +${fmtDelta(next - b.scenario.startTimeMillis)} (no fire)`,
        at: next,
      });
    for (const step of b.scenario.bounds.clockSteps ?? [])
      moves.push({
        kind: "tick",
        key: `tick:+${step}`,
        label: `tick +${fmtDelta(step)}`,
        at: w.clock + step,
      });
  }
  return moves.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
};

const runLabel = (pk: string, d: { tag: string; source: string; seq: number }, tries: number) => {
  const p = splitPartition(pk);
  return `${p.target} ← ${d.tag} (${d.source}#${d.seq})${tries > 0 ? ` retry ${tries}` : ""}`;
};

const timerLabel = (b: Built, w: World, t: TimerRec) =>
  `timer ${(t.command as { _tag?: string })?._tag} on ${t.agg}/${t.id} at +${fmtDelta(Math.max(t.at, w.clock) - b.scenario.startTimeMillis)}${t.at < w.clock ? " (late)" : ""}`;

export const fmtDelta = (ms: number) => {
  const h = ms / 3_600_000;
  return h >= 24
    ? `${(h / 24).toFixed(h % 24 === 0 ? 0 : 2)}d`
    : `${h.toFixed(h % 1 === 0 ? 0 : 2)}h`;
};

// ───────────────────────────────────────────────────── Move effects ──

const asEffect = (b: Built, move: Move): Effect.Effect<void, unknown> => {
  const rt = b.rt;
  switch (move.kind) {
    case "actor":
      return Effect.suspend(() => {
        rt.by = { kind: "actor", name: move.actor!.key };
        rt.input = move.key;
        if ("actors" in rt.world.budget) {
          rt.world.budget.actors = rt.world.budget.actors! - 1;
        }
        return move.actor!.run(b.ctx).pipe(Effect.asVoid);
      });
    case "run":
      return runWork(b, move.key.slice(4));
    case "redeliver":
      return Effect.suspend(() => {
        const pk = move.key.slice("redeliver:".length);
        const q = rt.world.delivered[pk]!;
        rt.world.budget.redeliveries = (rt.world.budget.redeliveries ?? 0) - 1;
        (rt.world.work[pk] ??= []).unshift({ d: q.d, tries: 0 });
        const last = (rt.world.budget.redeliveries ?? 0) <= 0;
        return runWork(b, pk).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (last) rt.world.delivered = {};
            }),
          ),
        );
      });
    case "timer":
      return fireTimer(b, move.key.slice("timer:".length));
    case "tick":
      return Effect.sync(() => {
        rt.world.budget.ticks = (rt.world.budget.ticks ?? 0) - 1;
        rt.world.clock = move.at!;
      });
  }
};

const fireTimer = (b: Built, key: string) =>
  Effect.suspend(() => {
    const rt = b.rt;
    const t = rt.world.timers[key];
    if (!t) return Effect.void;
    if (t.at > rt.world.clock) {
      rt.world.clock = t.at;
    }
    rt.by = { kind: "timer", name: key };
    rt.input = `timer:${key}`;
    const store = rt.aggregates.get(t.agg)!;
    // The timer stays armed until its command commits (durable).
    return store.commit(t.id, t.command, { ...t.meta }).pipe(
      Effect.tap(() => Effect.sync(() => void delete rt.world.timers[key])),
      Effect.asVoid,
    );
  });

const deadOf = (
  kind: Dead["kind"],
  target: string,
  key: string,
  d: { tag: string; source: string; seq: number },
  error: string,
): Dead => ({
  kind,
  target,
  key,
  tag: d.tag,
  source: d.source,
  seq: d.seq,
  error,
});

/** Run the head of a partition (`policy|…`, `view|…`, `projection|…`). */
const runWork = (b: Built, pk: string): Effect.Effect<void, unknown> =>
  Effect.suspend(() => {
    const rt = b.rt;
    const { kind, target, key } = splitPartition(pk);
    if (kind === "projection") return runProjection(b, target, key, pk, false);
    const items = rt.world.work[pk] ?? [];
    const q = items[0];
    if (!q) return Effect.void;
    const remove = () => {
      items.splice(items.indexOf(q), 1);
      if (items.length === 0) delete rt.world.work[pk];
    };
    if (kind === "view") {
      rt.by = { kind: "view", name: target };
      const kit = rt.views.get(target)!;
      const part = ((rt.world.views[target] ??= {})[key] ??= {
        snapshot: { state: null, version: 0, checkpoints: {}, seq: 0 },
        entries: [],
      });
      return Effect.try({
        try: () => kit.apply(key, part.snapshot, [q.d]),
        catch: (e) => e,
      }).pipe(
        Effect.flatMap((result) => {
          remove();
          if (!result.changed) return Effect.void;
          part.snapshot = JSON.parse(JSON.stringify(result.snapshot));
          part.entries.push(...JSON.parse(JSON.stringify(result.entries)));
          return Effect.forEach(result.downstream, (d) => kit.deliver(d), { discard: true });
        }),
        Effect.catch((e: unknown) =>
          Effect.sync(() => {
            const error = String((e as Error)?.message ?? e);
            rt.log.defects.push({ where: `view ${target} on ${q.d.tag}`, error });
            q.tries++;
            if (q.tries > maxTriesOf(b)) {
              remove();
              rt.world.dead.push(deadOf("view", target, key, q.d, error));
            }
          }),
        ),
      );
    }
    rt.by = { kind: "policy", name: target };
    rt.input = `${target}|${q.d.source}#${q.d.seq}`;
    rt.inputSource = q.d.source;
    rt.inputSeq = q.d.seq;
    const kit = rt.policies.get(target)!;
    return Effect.exit(kit.run(q.d)).pipe(
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            remove();
            if ((rt.world.budget.redeliveries ?? 0) > 0) {
              rt.world.delivered[pk] = { d: q.d, tries: 0 };
            }
            return;
          }
          rt.log.ok = false;
          const c = classify(exit.cause, rt.profile);
          if (c === "engine") throw Cause.squash(exit.cause);
          const error = errorText(exit.cause);
          if (c === "defect")
            rt.log.defects.push({ where: `policy ${target} on ${q.d.tag}`, error });
          rt.log.failures.push({ where: `policy ${target} on ${q.d.tag}`, error });
          q.tries++;
          if (q.tries > maxTriesOf(b)) {
            remove();
            rt.world.dead.push(deadOf("policy", target, key, q.d, error));
          }
        }),
      ),
    );
  });

const runProjection = (
  b: Built,
  name: string,
  key: string,
  pk: string,
  inline: boolean,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const rt = b.rt;
    const part = rt.world.proj[name]?.[key];
    if (!part || part.stuck || part.pending.length === 0) return Effect.void;
    rt.by = { kind: "projection", name };
    const kit = rt.projections.get(name)!;
    const size = Math.max(1, kit.options.batch?.size ?? 1);
    const most = Math.min(size, part.pending.length);
    const n = inline ? most : 1;
    const batch = part.pending.slice(0, n);
    return Effect.exit(kit.run(key, batch)).pipe(
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            part.pending.splice(0, n);
            part.tries = 0;
            for (const a of batch)
              part.checkpoints[a.delivery.source] = Math.max(
                part.checkpoints[a.delivery.source] ?? 0,
                a.delivery.seq,
              );
            return;
          }
          const c = classify(exit.cause, rt.profile);
          if (c === "engine") throw Cause.squash(exit.cause);
          const error = errorText(exit.cause);
          if (c === "defect") rt.log.defects.push({ where: `projection ${name}`, error });
          rt.log.failures.push({ where: `projection ${name}`, error });
          part.tries++;
          if (part.tries > maxTriesOf(b)) {
            part.stuck = true;
            rt.world.dead.push(deadOf("projection", name, key, batch[0]!.delivery, error));
          }
        }),
      ),
    );
  });

/** Views and projections declared `inline`: run what the step queued, in partition order. */
const drainInline = (b: Built): Effect.Effect<void, unknown> =>
  Effect.suspend(() => {
    const rt = b.rt;
    const views = b.scenario.host?.views ?? {};
    const projections = b.scenario.host?.projections ?? {};
    const tried = new Set<string>();
    const loop = (): Effect.Effect<void, unknown> =>
      Effect.suspend(() => {
        for (const pk of Object.keys(rt.world.work).sort()) {
          const p = splitPartition(pk);
          if (p.kind !== "view" || views[p.target] !== "inline") continue;
          const sig = `${pk}:${rt.world.work[pk]!.length}:${rt.world.work[pk]![0]!.tries}`;
          if (tried.has(sig)) continue;
          tried.add(sig);
          return runWork(b, pk).pipe(Effect.andThen(loop));
        }
        for (const name of Object.keys(rt.world.proj).sort()) {
          if (projections[name] !== "inline") continue;
          for (const key of Object.keys(rt.world.proj[name]!).sort()) {
            const part = rt.world.proj[name]![key]!;
            if (part.stuck || part.pending.length === 0) continue;
            const sig = `projection|${name}|${key}:${part.pending.length}:${part.tries}`;
            if (tried.has(sig)) continue;
            tried.add(sig);
            return runProjection(b, name, key, partitionKey("projection", name, key), true).pipe(
              Effect.andThen(loop),
            );
          }
        }
        return Effect.void;
      });
    return loop();
  });

// ─────────────────────────────────────────────────── Run one move ──

export interface Leaf {
  readonly world: World;
  readonly log: StepLog;
  readonly script: Array<ScriptEntry>;
  readonly engine: ReadonlyArray<EngineError>;
}

const clone = <A>(a: A): A => JSON.parse(JSON.stringify(a));

const runIn = (b: Built, eff: Effect.Effect<void, unknown>) =>
  sandboxed(b.rt, () =>
    withActive(b.rt, () =>
      Effect.runSyncExit(
        eff.pipe(
          Effect.provideContext(b.ctx),
          Effect.provideService(Clock.Clock, worldClock(b.rt)),
          Effect.provide(quiet),
          Effect.withTracerEnabled(false),
        ) as Effect.Effect<void, unknown>,
      ),
    ),
  );

/** Run one move once from `world` with a choice script (the scripted prefix; later choices take 0, or random in a swarm). */
export const runOnce = (
  b: Built,
  world: World,
  move: Move,
  script: ReadonlyArray<ScriptEntry>,
): Leaf => {
  const rt = b.rt;
  rt.world = clone(world);
  rt.log = emptyLog();
  rt.script = script;
  rt.pos = 0;
  rt.taken = [];
  rt.engine = [];
  rt.by = { kind: "engine", name: move.kind };
  rt.input = move.key;
  rt.inputSource = undefined;
  rt.inputSeq = 0;
  const exit = runIn(
    b,
    asEffect(b, move).pipe(
      Effect.exit,
      Effect.flatMap((main) => Effect.as(drainInline(b), main)),
    ) as never,
  );
  const engine: Array<EngineError> = [...rt.engine];
  const report = (cause: Cause.Cause<unknown>, where: string) => {
    const c = classify(cause, rt.profile);
    if (c === "engine") {
      const e = engineErrorOf(cause);
      if (!rt.engine.some((x) => x.kind === e.kind && x.detail === e.detail))
        engine.push({ ...e, move: move.key });
    } else if (c === "defect") rt.log.defects.push({ where, error: errorText(cause) });
    else if (c === "hostFault") rt.log.failures.push({ where, error: errorText(cause) });
    else rt.log.failures.push({ where, error: errorText(cause) });
  };
  if (Exit.isFailure(exit)) {
    report(exit.cause, move.label);
    rt.log.ok = false;
  } else {
    const main = exit.value as unknown as Exit.Exit<void, unknown>;
    if (Exit.isFailure(main)) {
      report(main.cause, move.kind === "actor" ? `actor ${move.label}` : move.label);
      rt.log.ok = false;
    }
  }
  for (const e of rt.engine)
    if (!engine.some((x) => x.kind === e.kind && x.detail === e.detail)) engine.push(e);
  if (rt.pos < script.length)
    engine.push({
      kind: "ReplayDiverged",
      detail: `the move used ${rt.pos} of ${script.length} scripted choices`,
      move: move.key,
    });
  return {
    world: rt.world,
    log: rt.log,
    script: rt.taken,
    engine: engine.map((e) => ({ ...e, move: e.move ?? move.key })),
  };
};

/** Every leaf of a move's choice tree. */
export const runAll = (
  b: Built,
  world: World,
  move: Move,
): { leaves: Array<Leaf>; runs: number } => {
  const leaves: Array<Leaf> = [];
  const scripts: Array<Array<ScriptEntry>> = [[]];
  let runs = 0;
  while (scripts.length > 0) {
    const script = scripts.pop()!;
    const leaf = runOnce(b, world, move, script);
    runs++;
    for (let p = script.length; p < leaf.script.length; p++)
      for (let k = 1; k < leaf.script[p]!.n; k++)
        scripts.push([...leaf.script.slice(0, p), { ...leaf.script[p]!, chosen: k }]);
    leaves.push(leaf);
    if (leaf.engine.length > 0) break;
  }
  return { leaves, runs };
};

export const stepOf = (move: Move, leaf: Leaf): Step => ({
  move: { kind: move.kind, key: move.key, label: move.label },
  commits: leaf.log.commits,
  rejections: leaf.log.rejections,
  calls: leaf.log.calls,
  failures: leaf.log.failures,
  defects: leaf.log.defects,
  sends: leaf.log.sends,
  refusedSchedules: leaf.log.refusedSchedules,
  ok: leaf.log.ok,
});

// ──────────────────────────────────────────────────────────── Rules ──

/** The rules a world (after a step, or the root with no step) breaks: `[ruleId, message]`. */
export const checkRules = (
  b: Built,
  world: World,
  step: Step | undefined,
  skip?: ReadonlySet<string>,
): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const snap = new Snapshot(world, b.abstractViews);
  const quiet = isQuiescent(world);
  for (const rule of b.rules) {
    if (skip?.has(rule.id)) continue;
    let m: string | undefined;
    if (rule.kind === "state") m = rule.check(snap);
    else if (rule.kind === "step") m = step ? rule.check(snap, step) : undefined;
    else if (rule.kind === "quiescent") m = quiet ? rule.check(snap) : undefined;
    else if (quiet && rule.when(snap)) m = runOut(b, world, rule.horizonMillis, rule.goal);
    if (m !== undefined) out.push([rule.id, m]);
  }
  return out;
};

/** Rules whose trigger this state or step witnesses; `skip` holds `witness:<id>` for those already seen. */
export const witnessesOf = (
  b: Built,
  world: World,
  step: Step | undefined,
  skip?: ReadonlySet<string>,
): Array<string> => {
  const out: Array<string> = [];
  let snap: Snapshot | undefined;
  for (const rule of b.rules) {
    const r = rule.reachable;
    if (!r || skip?.has(`witness:${rule.id}`)) continue;
    snap ??= new Snapshot(world, b.abstractViews);
    if (r.state?.(snap) || (step && r.step?.(snap, step))) out.push(rule.id);
  }
  return out;
};

/** `eventually`: timers and work only, default choices, no faults, for `horizon` of model time. */
export const runOut = (
  b: Built,
  world: World,
  horizon: number,
  goal: (s: Snapshot) => string | undefined,
): string | undefined => {
  const rt = b.rt;
  const end = world.clock + horizon;
  let w = world;
  rt.calm = true;
  try {
    for (let i = 0; i < 1000; i++) {
      const moves = enabled(b, w).filter(
        (m) => m.kind === "run" || (m.kind === "timer" && m.at! <= end),
      );
      if (moves.length === 0)
        return goal(new Snapshot({ ...w, clock: Math.max(w.clock, end) }, b.abstractViews));
      const leaf = runOnce(b, w, moves[0]!, []);
      if (leaf.engine.length > 0)
        throw new EngineFault(leaf.engine[0]!.kind, leaf.engine[0]!.detail);
      w = leaf.world;
    }
    return "the run-out did not settle in 1000 moves";
  } finally {
    rt.calm = false;
  }
};

// ─────────────────────────────────────────────────── Canonical state ──

/** The identity of a world: all of it, except `delivered` once no redelivery can happen (only the redeliver move reads it). */
export const identityOf = (w: World): unknown =>
  (w.budget.redeliveries ?? 0) > 0 ? w : { ...w, delivered: {} };

export interface Canon {
  readonly text: string;
  readonly digest: Digest;
}

export const canonOf = (w: World): Canon => {
  const text = canonical(identityOf(w));
  return { text, digest: digest(text) };
};

export type { By, Provided, Send, World };

// ───────────────────────────────────────────────────── Actor helper ──

/** Send one command as an actor (recorded for step rules and the Story). */
export const send = <A extends Aggregate.Any>(
  ctx: Context.Context<any>,
  aggregate: A,
  id: string,
  command: Aggregate.CommandOf<A>,
  options: { readonly commandId: string; readonly provide?: ReadonlyArray<Provided> },
): Effect.Effect<any, unknown> =>
  Effect.suspend(() => {
    const rt = activeRt();
    const sent: Send = {
      agg: aggregate.aggregateName,
      id,
      command,
      commandId: options.commandId,
      provide: options.provide ?? [],
    };
    rt.log.sends.push(sent);
    const client = Context.getUnsafe(ctx, aggregate as unknown as Context.Key<any, any>) as {
      send: (id: string, c: unknown, o: unknown) => Effect.Effect<any, any>;
    };
    let eff = client.send(id, command, { commandId: options.commandId });
    for (const p of options.provide ?? []) eff = Effect.provideService(eff, p.key, p.value);
    return eff.pipe(
      Effect.tapError((e: any) => Effect.sync(() => (sent.rejection = e))),
      Effect.tapDefect((d: any) =>
        Effect.sync(() => (sent.fault = d instanceof Error ? d.message : String(d))),
      ),
    );
  });

export { byText };
