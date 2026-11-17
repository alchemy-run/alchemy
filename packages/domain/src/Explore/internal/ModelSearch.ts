import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import type * as Decision from "../../Decision.ts";
import * as ExternalSystem from "../../ExternalSystem.ts";
import * as Key from "../../Key.ts";
import * as Check from "../../Prove/internal/Check.ts";
import * as Decide from "../../Prove/internal/Decide.ts";
import * as Induction from "../../Prove/internal/Induction.ts";
import type { Interpreter } from "../../Prove/internal/Interpreter.ts";
import * as Paths from "../../Prove/internal/Paths.ts";
import * as Relations from "../../Prove/internal/Relations.ts";
import * as Smt from "../../Prove/internal/Smt.ts";
import type * as Source from "../../Prove/internal/Source.ts";
import * as Symbolic from "../../Prove/internal/Symbolic.ts";
import type { Eval, Module, Node, Site, V } from "../../Prove/internal/Value.ts";
import * as Value from "../../Prove/internal/Value.ts";
import type { Move } from "./Search.ts";
import { lift, stateTags, tagOf } from "./Search.ts";

/** One command of a story: who it went to, and who sent it. */
export interface Step extends Move {
  /** The aggregate the command went to: for a decision, the first it read. */
  readonly aggregate: string;
  readonly id: string;
  /**
   * For a command a decision implements: what it recorded, instance by
   * instance. `undefined` for a command one aggregate handles.
   */
  readonly recorded:
    | ReadonlyArray<{
        readonly aggregate: string;
        readonly id: string;
        readonly events: ReadonlyArray<unknown>;
      }>
    | undefined;
  /** The policy or saga that sent the command; `undefined` when a caller did, or a schedule. */
  readonly by: string | undefined;
  /** The delay of the schedule that sent the command, as the code wrote it. */
  readonly after: string | undefined;
  /** What the external systems answered after the command, before the next one ran. */
  readonly asked: ReadonlyArray<Asked>;
  /**
   * Whether it was sent a second time round: by a policy handling an event it
   * had handled before, or by a saga running a step it had run before.
   */
  readonly again: boolean;
  /** The saga step that sent it, by name. */
  readonly step: string | undefined;
  /**
   * Whether a scheduled command was due by then and had not run. A platform
   * runs each instance's schedule on its own, so one can run late.
   */
  readonly late: boolean;
}

/** One call to an external system, and the answer the solver picked for it. */
export interface Asked {
  /** The policy or saga that called. */
  readonly by: string | undefined;
  /** The system and its operation: `FraudCheck.score`. */
  readonly call: string;
  /** The operation itself, as the system's class holds it. */
  readonly op: unknown;
  readonly answer: unknown;
  /** Whether the answer is one of the operation's declared errors. */
  readonly failed: boolean;
  /** Whether the call was made a second time round, as a command is. */
  readonly again: boolean;
  /** The saga step that called, by name. */
  readonly step: string | undefined;
}

/** Commands callers send one after another, each followed by what the policies do about it. */
export type Story = ReadonlyArray<Step>;

export interface Outcome {
  /** The aggregate that handles the command: `undefined` for a command a decision implements. */
  readonly aggregate: string | undefined;
  readonly command: string;
  readonly kind: "records" | "rejects";
  readonly tag: string;
  /** The shortest story found that ends in it. */
  readonly story: Story | undefined;
}

/** One way a saga's run can stop. */
export interface Ending {
  readonly saga: string;
  /** `completes`, `fails with <rejection>`, or `waits for <signal>`. */
  readonly ending: string;
  /** The shortest story found that gets a run there. */
  readonly story: Story | undefined;
}

/** A policy or saga the explorer left out, and the code it could not read. */
export interface Skipped {
  readonly policy: string;
  readonly reason: string;
  readonly file: string | undefined;
  readonly line: number | undefined;
}

/** A part of the model the sequences were run without, which no rule depends on. */
export interface Aside {
  readonly kind: "view" | "projection" | "stream" | "query";
  readonly name: string;
  readonly reason: string;
}

export interface Found {
  /** The command sequences run, one per path through the code. */
  readonly sequences: number;
  /** The states whose invariants were checked. */
  readonly states: number;
  readonly truncated: boolean;
  /** The most commands in a sequence for which every sequence was run. */
  readonly complete: number;
  readonly invariants: ReadonlyArray<{
    readonly aggregate: string;
    readonly name: string;
    /** An invariant is about a state, a transition about one step. */
    readonly kind: "invariant" | "transition";
    readonly broken: Story | undefined;
    readonly proved: boolean;
    /** The states reached in which it was looked at. */
    readonly states: number;
  }>;
  /**
   * The model's own invariants, looked at whenever a sequence has nothing left
   * to react: `broken` is the shortest sequence found that breaks one, and
   * `states` is how many times one was looked at.
   */
  readonly rules: ReadonlyArray<{
    readonly name: string;
    /** An invariant is given every instance; a relation is about a few, so it can be proved. */
    readonly kind: "invariant" | "relation";
    readonly broken: Story | undefined;
    /** A relation every command and every decision keeps, from any states the rules allow. */
    readonly proved: boolean;
    /** For a relation that is not proved: what the proof fails on. */
    readonly unproved: { readonly by: string; readonly verdict: Check.Verdict } | undefined;
    readonly states: number;
  }>;
  /**
   * What the model says holds once everything has run its course, looked at
   * whenever a sequence has nothing left to react and no command scheduled:
   * `broken` is the shortest sequence found that ends without it, and
   * `states` is how many sequences were run to their end.
   */
  readonly eventually: ReadonlyArray<{
    readonly name: string;
    readonly broken: Story | undefined;
    readonly states: number;
  }>;
  /**
   * The commands no state the invariants allow accepts: they never record an
   * event, so nothing said here is about them.
   */
  readonly dead: ReadonlyArray<string>;
  /** The decisions run in the sequences, each by the command it implements. */
  readonly decisions: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly reached: ReadonlyArray<{
    readonly aggregate: string;
    readonly tag: string;
    readonly story: Story | undefined;
  }>;
  /** The policies whose reactions were run. */
  readonly followed: ReadonlyArray<string>;
  /** The policies no sequence recorded an event for. */
  readonly idle: ReadonlyArray<string>;
  /** The views folded along every sequence: a policy reacts to one, or an invariant reads one. */
  readonly views: ReadonlyArray<string>;
  /** The projections an invariant reads: what each is given is followed along every sequence. */
  readonly projections: ReadonlyArray<string>;
  /** The external systems called, each answered with every answer its schema allows. */
  readonly systems: ReadonlyArray<string>;
  /** The ways delivery went wrong that the sequences were run with. */
  readonly faults: {
    readonly redeliver: boolean;
    readonly reorder: boolean;
    readonly rerun: boolean;
  };
  /**
   * The longer sequences run past the ones every sequence was run to: each a
   * walk of commands picked at random, from a seed that picks the same again.
   */
  readonly walks: {
    readonly seed: number;
    /** The walks run. */
    readonly count: number;
    /** The commands callers sent in them, all together. */
    readonly commands: number;
    /** The most commands callers sent in one. */
    readonly longest: number;
    /** Each walk as it ended, with the values the solver picked: a story to run on the real model. */
    readonly stories: ReadonlyArray<Story>;
  };
  /**
   * The external calls a policy makes again when an event is delivered to it
   * again: each has to be safe to repeat, which the explorer cannot tell.
   */
  readonly repeated: ReadonlyArray<string>;
  /** The sagas that ran. */
  readonly sagas: ReadonlyArray<string>;
  /** The sagas no sequence started. */
  readonly unstarted: ReadonlyArray<string>;
  readonly endings: ReadonlyArray<Ending>;
  /** The policies and sagas left out: the sequences were run as if they did nothing. */
  readonly skipped: ReadonlyArray<Skipped>;
  /**
   * Every other part of the model the sequences were run without, by name: a
   * view or projection no rule reads and no policy reacts to, and each stream
   * and query. No rule depends on one, so leaving it out changes no result.
   */
  readonly aside: ReadonlyArray<Aside>;
  /**
   * What a command writes to a part of a state whose schema has a check the
   * prover does not read: the new value is not proved to pass it.
   */
  readonly unkept: ReadonlyArray<string>;
  /** A rejection a policy does not handle: its handler fails with it. */
  readonly failures: ReadonlyArray<{
    readonly policy: string;
    readonly tag: string;
    readonly story: Story;
  }>;
  /** Sequences whose reactions were still going after the most the explorer follows. */
  readonly unsettled: number;
  readonly unread: ReadonlyArray<Value.NotTranslated>;
  readonly disagreements: ReadonlyArray<string>;
  readonly undecided: ReadonlyArray<{ readonly reason: string; readonly times: number }>;
}

export interface Options {
  /** The most commands callers send in a sequence. */
  readonly depth: number;
  readonly budget: number;
  /** The most instances of one aggregate in a sequence. */
  readonly instances: number;
  readonly faults: {
    /** Deliver each event to each policy twice: the kernel delivers at least once. */
    readonly redeliver: boolean;
    /** Run the reactions waiting at the same time in other orders too. */
    readonly reorder: boolean;
    /** Run a saga's step again, as when it stopped before its result was kept. */
    readonly rerun: boolean;
  };
  /** Longer sequences to run after every short one: how many, of how many commands, from which seed. */
  readonly walks: { readonly count: number; readonly length: number; readonly seed: number };
}

/** A model, as far as the explorer reads it. */
export interface ModelLike {
  readonly modelName: string;
  readonly definitions: {
    readonly aggregates: ReadonlyArray<Aggregate.Any>;
    readonly decisions?: ReadonlyArray<Decision.Any>;
    readonly views?: ReadonlyArray<unknown>;
    readonly policies: ReadonlyArray<unknown>;
    readonly projections?: ReadonlyArray<unknown>;
    readonly streams?: ReadonlyArray<unknown>;
  };
  readonly sagas?: ReadonlyArray<unknown>;
  readonly queries?: ReadonlyArray<unknown>;
  readonly invariants?: { readonly [name: string]: (model: never) => boolean };
  readonly eventually?: { readonly [name: string]: (model: never) => boolean };
  readonly relations?: {
    readonly [name: string]: {
      readonly over: Readonly<Record<string, Aggregate.Any>>;
      readonly holds: (on: never) => boolean;
    };
  };
}

interface PolicyClass {
  readonly policyName: string;
  readonly definition: { readonly from: unknown; readonly on: unknown };
}

interface CommandClass extends Paths.CommandClass {
  readonly events: ReadonlyArray<{ readonly tag: string }>;
  readonly rejects: ReadonlyArray<{ readonly tag: string }>;
}

type RealHandler = (...args: ReadonlyArray<unknown>) => unknown;

interface ViewClass {
  readonly viewName: string;
  readonly definition: {
    readonly from: ReadonlyArray<unknown>;
    readonly key: unknown;
    readonly state?: unknown;
    readonly initial?: unknown;
    readonly keyOf?: unknown;
    readonly evolve?: Readonly<Record<string, unknown>>;
    readonly events?: ReadonlyArray<{ readonly tag: string }>;
    readonly emit?: Readonly<Record<string, unknown>>;
    /** A projection's events. */
    readonly on?: ReadonlyArray<unknown>;
  };
}

/** A view or a projection the explorer follows: what reads the model's events, key by key. */
interface ViewImpl {
  readonly name: string;
  /** A projection keeps no state the model declares: what it is given is what is known of it. */
  readonly kind: "view" | "projection";
  readonly cls: ViewClass;
  readonly definition: Paths.Definition;
  /** The aggregates and views it reads, by class, with the name its handlers know each by. */
  readonly sources: ReadonlyMap<unknown, string>;
  /** The name of the aggregate that keys it: `undefined` when a value does. */
  readonly keyedBy: string | undefined;
  readonly stateful: boolean;
  readonly initial: V;
  /** The events it says it emits: without them it passes on each event it folds. */
  readonly declared: ReadonlySet<string> | undefined;
  /** For a projection: the events it handles. */
  readonly on: ReadonlyArray<unknown>;
}

interface SystemClass {
  readonly systemName: string;
  readonly ops: Readonly<Record<string, ExternalSystem.OpSpec>>;
}

interface Agg {
  readonly cls: Aggregate.Any;
  readonly name: string;
  readonly definition: Paths.Definition;
  readonly commands: ReadonlyArray<CommandClass>;
  readonly initial: V;
  /** The names of its invariants, then of its transitions. */
  readonly invariants: ReadonlyArray<string>;
  readonly transitions: ReadonlySet<string>;
  /** The real invariants, on a state. */
  readonly real: Readonly<Record<string, (state: unknown) => boolean>>;
  /** The real invariants and transitions, on a step. */
  readonly rules: Readonly<Record<string, Check.Kept["holds"]>>;
}

/** A decision the explorer follows: one command, decided across the instances it names. */
interface Decided extends Induction.DecisionImpl {
  /** The tag of the command it implements. */
  readonly name: string;
  readonly command: CommandClass;
  /** The aggregate behind each name in `reads`. */
  readonly aggs: Readonly<Record<string, Agg>>;
  /** The names of its own transitions. */
  readonly own: ReadonlyArray<string>;
}

interface PolicyImpl {
  readonly name: string;
  readonly from: unknown;
  readonly on: ReadonlyArray<unknown>;
  readonly module: Module;
  /** The handler's construction: the argument of `toLayer`. */
  readonly node: Node;
  /**
   * The aggregates its handler names, so may send to: `undefined` when it
   * names a saga, whose steps may send to any.
   */
  readonly writes: ReadonlySet<unknown> | undefined;
}

interface SagaClass {
  readonly sagaName: string;
  readonly definition: { readonly rejects?: ReadonlyArray<{ readonly tag: string }> };
  readonly withCompensation: unknown;
}

interface SagaImpl {
  readonly name: string;
  readonly cls: SagaClass;
  /** The rejections a run may end in. */
  readonly rejects: ReadonlyArray<string>;
  readonly module: Module;
  /** The handler's construction: the argument of `toLayer`. */
  readonly node: Node;
}

/** What an activity gave when it ran. A run that resumes reads it and does not run the activity again. */
type Journaled =
  | { readonly _tag: "Success"; readonly value: V }
  | { readonly _tag: "Failure"; readonly rejection: V };

/** One run of a saga, by its key. */
interface SagaRun {
  readonly saga: SagaImpl;
  readonly key: V;
  /** `undefined` until a policy starts the run: a signal can come first. */
  readonly input: V | undefined;
  readonly journal: ReadonlyMap<string, Journaled>;
  readonly signals: ReadonlyMap<string, V>;
  /** The signal the run stopped to wait for. */
  readonly waiting: string | undefined;
  readonly done: boolean;
}

/** A command scheduled for later. */
interface Timer {
  readonly agg: Agg;
  readonly address: V;
  readonly command: V;
  readonly cls: CommandClass;
  readonly commandId: string;
  /** The time of the command it was scheduled after, as the solver names it. */
  readonly since: string;
  readonly millis: number;
  /** The delay as the code wrote it. */
  readonly after: string;
  /** The policy or saga that scheduled it. */
  readonly by: string | undefined;
}

interface Instance {
  readonly agg: Agg;
  readonly id: V;
  readonly state: V;
  readonly version: number;
}

/** What a decision did to one of the instances it read. */
interface EntryPart {
  readonly agg: Agg;
  readonly instance: number;
  readonly events: ReadonlyArray<V>;
  readonly state: V;
  readonly checks: ReadonlyArray<Paths.Check>;
}

interface Entry {
  /** For a decision: the first aggregate it read. */
  readonly agg: Agg;
  readonly instance: number;
  /** Set for a command a decision implements: what it did, instance by instance, and its own rules. */
  readonly decided?: {
    readonly decision: Decided;
    readonly parts: ReadonlyArray<EntryPart>;
    readonly own: ReadonlyArray<Paths.Check>;
  };
  readonly command: CommandClass;
  readonly label: string;
  readonly inputs: Paths.Inputs;
  readonly applied: Paths.Applied;
  readonly checks: ReadonlyArray<Paths.Check>;
  readonly by: string | undefined;
  readonly after: string | undefined;
  /** What each view emitted for the command's events, by the view's name. */
  readonly emitted: Array<{ readonly view: ViewImpl; readonly tags: ReadonlyArray<string> }>;
  /** Sent by a policy handling an event again, or by a saga running a step again. */
  readonly again: boolean;
  /** The saga step that sent it. */
  readonly step: string | undefined;
  /** The commands still scheduled when it ran: when each was scheduled, and its delay. */
  readonly pending: ReadonlyArray<{ readonly since: string; readonly millis: number }>;
}

/**
 * What gives commands their ids: the delivery of an event to a policy, or a
 * step of a saga. Run again, it sends the same commands under the same ids.
 */
interface Scope {
  readonly key: string;
  /** It ran once already. */
  readonly again: boolean;
  /** The saga step, by name. */
  readonly step?: string;
  ordinal: number;
  /** A command it sent was refused: run again, the command is decided again. */
  refused: boolean;
}

/** What a policy's send gave the first time: a second delivery of the event gets it again. */
interface Receipt {
  readonly instance: number;
  readonly applied: Paths.Applied;
}

/** What a projection was given: an event, under a key, with its source's state. */
interface Fed {
  readonly view: ViewImpl;
  readonly key: V;
  readonly event: V;
  readonly state: V;
}

/** One key of a view, and its state. */
interface ViewSlot {
  readonly view: ViewImpl;
  /** The id the key is under: an instance's, or a value. */
  readonly key: V;
  /** `undefined` once the view deleted the key. */
  readonly state: V | undefined;
}

/** A call to an external system: the answer is an input the solver picks. */
interface Call {
  /** The commands that had run when it was made. */
  readonly at: number;
  readonly by: string | undefined;
  readonly call: string;
  readonly op: unknown;
  readonly answer: V;
  readonly failed: boolean;
  readonly again: boolean;
  readonly step: string | undefined;
}

/** A saga's run to go on with: one just started, or one whose signal came. */
interface Resume {
  readonly resume: number;
}

interface Trigger {
  readonly policy: PolicyImpl;
  /** What the event came from, as the policy is given it: a ref, or a view's key. */
  readonly source: V;
  /** The id of what the event came from. */
  readonly id: V;
  readonly event: V;
  readonly parent: number;
  /** For a policy that reacts to a view: the view's state after the event. */
  readonly state?: V;
  /** Names the delivery: the commands the policy sends for it get ids derived from it. */
  readonly key: string;
  /** The policy has handled this event once already. */
  readonly again?: boolean;
  /** Put behind the other reactions that were waiting. */
  readonly deferred?: boolean;
}

/** One sequence while it runs. */
interface Sequence {
  readonly trail: Array<Entry>;
  readonly instances: Array<Instance>;
  readonly views: Array<ViewSlot>;
  readonly fed: Array<Fed>;
  readonly calls: Array<Call>;
  /** What each send of each delivery gave, by the delivery and the send's place in it. */
  readonly receipts: Map<string, Receipt>;
  /** What each schedule of each delivery gave. */
  readonly armed: Map<string, V>;
  /** What each decision a delivery sent gave, by the delivery and the send's place in it. */
  readonly decisions: Map<string, Paths.Decided>;
  readonly queue: Array<Trigger | Resume>;
  readonly sagas: Array<SagaRun>;
  timers: Array<Timer>;
  readonly failures: Array<{ readonly policy: string; readonly tag: string }>;
  /** How each run that stopped did, and how many commands had run by then. */
  readonly endings: Array<{ readonly saga: string; readonly ending: string; readonly at: number }>;
  unsettled: boolean;
  /** A reaction to the last command was put behind the others: one is, at most. */
  moved: boolean;
  /** A saga's step was run again: one is, at most. */
  reran: boolean;
  /** The policies, sagas and external systems that ran in it: they count once it can happen. */
  readonly ran: {
    readonly policies: Set<string>;
    readonly sagas: Set<string>;
    readonly systems: Set<string>;
    readonly repeated: Set<string>;
  };
  /** The model's invariants on what the sequence left, once nothing more reacts. */
  rules: ReadonlyArray<Paths.Check>;
  /** What the model says holds in the end, on what the sequence left with nothing scheduled. */
  later: ReadonlyArray<Paths.Check>;
}

/**
 * The first `length` commands of a story. What an external system answered
 * after the last of them belongs to what came next, which is cut off.
 */
const cut = (story: Story, length: number): Story => {
  if (length >= story.length) return story;
  const made = story
    .slice(0, length)
    .map((step, index) => (index === length - 1 ? { ...step, asked: [] } : step));
  wholes.set(made, story);
  return made;
};

/** The whole sequence each cut story was the start of. */
const wholes = new WeakMap<Story, Story>();

/**
 * The sequence a story is the start of, with everything the model did after
 * the story's last command: a story is cut where what it shows happened.
 */
export const whole = (story: Story): Story => wholes.get(story) ?? story;

/** The real code does something else than the explorer read. */
class Disagreement extends Data.TaggedError("Disagreement")<{ readonly reason: string }> {}

/** A policy's handler has code the explorer cannot read: the search starts over without it. */
class PolicyUnread extends Data.TaggedError("PolicyUnread")<{
  readonly policy: string;
  readonly error: Value.NotTranslated;
}> {}

/** What a saga's run stops with when it waits for a signal that has not come. */
const SUSPENDED: V = { _tag: "Opaque", what: "a saga waiting for a signal" };

/** Numbers between 0 and 1 from a seed: the same seed gives the same numbers, on every machine. */
const mulberry = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

/** The most schedules run one after another to bring a sequence to its end. */
const MAX_SCHEDULES = 8;

/** The most reactions followed after one command a caller sends. */
const MAX_REACTIONS = 96;

const native = (name: string, call: (args: ReadonlyArray<V>, site: Site) => Eval<V>): V => ({
  _tag: "Native",
  name,
  call,
});

/** A string as the solver reads it, or `undefined` when the value is not one. */
const textOf = (value: V | undefined): string | undefined =>
  value?._tag === "Str"
    ? Smt.string(value.value).text
    : value?._tag === "Term" && value.term.sort === "String"
      ? value.term.text
      : undefined;

const walk = (node: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const [key, value] of Object.entries(n))
    if (key !== "type" && typeof value === "object") walk(value, visit);
};

/**
 * Read the files a model's file imports, and find in them each aggregate's
 * definition and each policy's handler.
 */
export const locate = Effect.fn(function* (
  loader: Source.Loader,
  interpreter: Interpreter,
  model: ModelLike,
  file: string,
) {
  const modules: Array<Module> = [];
  const seen = new Set([file]);
  const pending = [file];
  while (pending.length > 0) {
    const next = pending.shift()!;
    const module = yield* loader.load(next).pipe(
      // A file the model's own does not need to load is one the explorer does not read.
      Effect.catchTag("LoadError", (error) =>
        next === file ? Effect.fail(error) : Effect.succeed(undefined),
      ),
    );
    if (!module) continue;
    modules.push(module);
    for (const resolved of module.resolved.values())
      if (!seen.has(resolved)) {
        seen.add(resolved);
        pending.push(resolved);
      }
  }

  const aggregates: Array<Agg> = [];
  const missing: Array<string> = [];
  const unread: Array<string> = [];
  for (const cls of model.definitions.aggregates) {
    const module = modules.find(
      (m) =>
        Object.values(m.exports).includes(cls) &&
        Paths.find(m.program, cls.aggregateName, "evolve") !== undefined,
    );
    if (!module) {
      missing.push(cls.aggregateName);
      continue;
    }
    const definition: Paths.Definition = {
      module,
      node: Paths.find(module.program, cls.aggregateName, "evolve")!,
      name: cls.aggregateName,
      state: cls.definition.state,
    };
    unread.push(
      ...Paths.unread(definition, cls.definition).map((name) => `${cls.aggregateName}.${name}`),
    );
    aggregates.push({
      cls,
      name: cls.aggregateName,
      definition,
      commands: cls.definition.commands as unknown as ReadonlyArray<CommandClass>,
      initial: lift(cls.definition.initial),
      invariants: Paths.ruleNames(definition),
      transitions: new Set(Paths.transitionNames(definition)),
      real: (cls.definition.invariants ?? {}) as unknown as Record<
        string,
        (state: unknown) => boolean
      >,
      rules: Check.rules(cls),
    });
  }

  const decisions: Array<Decided> = [];
  for (const cls of model.definitions.decisions ?? []) {
    const found = yield* Induction.locate(interpreter, modules, cls);
    const aggs = Object.fromEntries(
      Object.entries(cls.reads).flatMap(([name, read]) => {
        const agg = aggregates.find((agg) => agg.cls === read);
        return agg ? [[name, agg] as const] : [];
      }),
    );
    if (typeof found === "string" || Object.keys(aggs).length < Object.keys(cls.reads).length) {
      missing.push(typeof found === "string" ? found : `what ${cls.decisionName} reads`);
      continue;
    }
    decisions.push({
      ...found,
      name: cls.decisionName,
      command: cls.command as unknown as CommandClass,
      aggs,
      own: Paths.decisionRuleNames(found.definition),
    });
    unread.push(
      ...Object.keys(cls.definition.transitions ?? {})
        .filter((name) => !Paths.decisionRuleNames(found.definition).includes(name))
        .map((name) => `${cls.decisionName}.${name}`),
    );
  }

  const classes = new Set([...model.definitions.policies, ...(model.sagas ?? [])]);
  const handlers = new Map<unknown, { readonly module: Module; readonly node: Node }>();
  for (const module of modules) {
    const calls: Array<Node> = [];
    walk(module.program, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property?.name === "toLayer" &&
        node.arguments?.[0]
      )
        calls.push(node);
    });
    for (const call of calls) {
      const owner = yield* interpreter
        .evaluate(call.callee.object as Node, interpreter.moduleEnv(module))
        .pipe(Effect.result);
      if (
        Result.isSuccess(owner) &&
        owner.success._tag === "Host" &&
        classes.has(owner.success.value)
      )
        handlers.set(owner.success.value, { module, node: call.arguments[0] as Node });
    }
  }

  // The model's own invariants, where its file declares them.
  const home = modules.find(
    (m) =>
      Paths.find(m.program, model.modelName, "aggregates") !== undefined &&
      Object.values(m.exports).includes(model),
  );
  const declared: Paths.Definition | undefined = home && {
    module: home,
    node: Paths.find(home.program, model.modelName, "aggregates")!,
    name: model.modelName,
    state: undefined,
  };
  /** The names the model's invariants use: a view one names is one they read. */
  const named = new Set<string>();
  if (declared)
    for (const property of declared.node.properties as ReadonlyArray<Node>)
      if (
        property.type === "Property" &&
        ["invariants", "eventually"].includes(String(property.key.name ?? property.key.value))
      )
        walk(property.value, (node) => {
          if (node.type === "Identifier" && typeof node.name === "string") named.add(node.name);
        });

  const views: Array<ViewImpl> = [];
  /** Why the explorer does not fold a view, by its class. */
  const unfolded = new Map<unknown, string>();
  const skipped: Array<Skipped> = [];
  /** What the sequences were run without, where no rule depends on it. */
  const aside: Array<Aside> = [];
  const readers: ReadonlyArray<{ readonly cls: ViewClass; readonly kind: "view" | "projection" }> =
    [
      ...((model.definitions.views ?? []) as ReadonlyArray<ViewClass>).map((cls) => ({
        cls,
        kind: "view" as const,
      })),
      ...((model.definitions.projections ?? []) as ReadonlyArray<ViewClass>).map((cls) => ({
        cls,
        kind: "projection" as const,
      })),
    ];
  for (const { cls, kind } of readers) {
    const def = cls.definition;
    const name =
      kind === "view"
        ? cls.viewName
        : (cls as unknown as { readonly projectionName: string }).projectionName;
    const module = modules.find(
      (m) =>
        Object.values(m.exports).includes(cls) && Paths.find(m.program, name, "from") !== undefined,
    );
    const sources = new Map<unknown, string>();
    let unknown: string | undefined;
    for (const source of def.from) {
      const agg = aggregates.find((agg) => agg.cls === source);
      const view = views.find((view) => view.cls === source);
      if (agg) sources.set(source, agg.name);
      else if (view && view.kind === "view") sources.set(source, view.name);
      else
        unknown =
          unfolded.get(source) === undefined
            ? "reads something the model does not list before it"
            : `reads ${(source as ViewClass).viewName}, a view that ${unfolded.get(source)}`;
    }
    const reason = !module ? "is not declared in a file the model's file imports" : unknown;
    if (reason !== undefined || !module) {
      unfolded.set(cls, reason ?? "is not followed");
      if (named.has(name))
        skipped.push({ policy: name, reason: reason!, file: undefined, line: undefined });
      else aside.push({ kind, name, reason: reason! });
      continue;
    }
    views.push({
      name,
      kind,
      cls,
      definition: {
        module,
        node: Paths.find(module.program, name, "from")!,
        name,
        state: def.state,
      },
      sources,
      keyedBy: aggregates.find((agg) => agg.cls === def.key)?.name,
      stateful: kind === "view" && def.state !== undefined,
      initial: lift(def.initial),
      declared: def.events ? new Set(def.events.map((event) => event.tag)) : undefined,
      on: def.on ?? [],
    });
  }

  /** The aggregates a handler's code names. Two handlers that name none in common cannot write the same instance. */
  const writesOf = Effect.fnUntraced(function* (module: Module, node: Node) {
    const names = new Map<string, Node>();
    walk(node, (inner) => {
      if (inner.type === "Identifier" && typeof inner.name === "string")
        names.set(inner.name, inner);
    });
    const writes = new Set<unknown>();
    for (const named of names.values()) {
      const value = yield* interpreter
        .evaluate(named, interpreter.moduleEnv(module))
        .pipe(Effect.result);
      if (Result.isFailure(value) || value.success._tag !== "Host") continue;
      const host = value.success.value;
      if ((model.sagas ?? []).includes(host)) return undefined;
      if (aggregates.some((agg) => agg.cls === host)) writes.add(host);
      // A decision it names writes to every aggregate the decision reads.
      for (const decision of decisions)
        if (decision.cls === host)
          for (const agg of Object.values(decision.aggs)) writes.add(agg.cls);
    }
    return writes;
  });

  const policies: Array<PolicyImpl> = [];
  for (const cls of model.definitions.policies as ReadonlyArray<PolicyClass>) {
    const leave = (reason: string) =>
      skipped.push({ policy: cls.policyName, reason, file: undefined, line: undefined });
    const handler = handlers.get(cls);
    const view = unfolded.get(cls.definition.from);
    if (view !== undefined)
      leave(`reacts to ${(cls.definition.from as ViewClass).viewName}, a view that ${view}`);
    else if (
      !aggregates.some((agg) => agg.cls === cls.definition.from) &&
      !views.some((view) => view.cls === cls.definition.from)
    )
      leave("reacts to something the model does not list");
    else if (!Array.isArray(cls.definition.on)) leave("its events are not a list");
    else if (!handler) leave("its toLayer is not in a file the model's file imports");
    else
      policies.push({
        name: cls.policyName,
        from: cls.definition.from,
        on: cls.definition.on,
        module: handler.module,
        node: handler.node,
        writes: yield* writesOf(handler.module, handler.node),
      });
  }
  const sagas: Array<SagaImpl> = [];
  for (const cls of (model.sagas ?? []) as ReadonlyArray<SagaClass>) {
    const handler = handlers.get(cls);
    if (!handler)
      skipped.push({
        policy: cls.sagaName,
        reason: "its toLayer is not in a file the model's file imports",
        file: undefined,
        line: undefined,
      });
    else
      sagas.push({
        name: cls.sagaName,
        cls,
        rejects: (cls.definition.rejects ?? []).map((rejection) => rejection.tag),
        module: handler.module,
        node: handler.node,
      });
  }
  unread.push(
    ...(declared ? Paths.unread(declared, model) : Object.keys(model.invariants ?? {})).map(
      (name) => `${model.modelName}.${name}`,
    ),
  );
  // A relation is about one instance for each of its names, no two the same.
  const written = declared ? Paths.relationNames(declared) : [];
  const relations: Array<Relations.Relation & { readonly aggs: ReadonlyArray<Agg> }> = [];
  for (const [name, relation] of Object.entries(model.relations ?? {})) {
    const over: Record<string, Relations.Over> = {};
    const aggs: Array<Agg> = [];
    for (const [key, cls] of Object.entries(relation.over)) {
      const agg = aggregates.find((agg) => agg.cls === cls);
      if (!agg) break;
      over[key] = { cls: agg.cls, definition: agg.definition, initial: agg.initial };
      aggs.push(agg);
    }
    if (!written.includes(name) || aggs.length !== Object.keys(relation.over).length) {
      unread.push(`${model.modelName}.${name}`);
      continue;
    }
    relations.push({
      name,
      over,
      aggs,
      real: relation.holds as unknown as Relations.Relation["real"],
    });
  }
  /** A relation on what a real model holds: every choice of instances, no two the same. */
  const everywhere =
    (relation: (typeof relations)[number]) =>
    (world: unknown): boolean => {
      const names = Object.keys(relation.over);
      const lists = names.map(
        (key) =>
          ((world as Record<string, ReadonlyArray<Relations.Real> | undefined>)[
            relation.over[key]!.cls.aggregateName
          ] ?? []) as ReadonlyArray<Relations.Real>,
      );
      const go = (at: number, chosen: ReadonlyArray<Relations.Real>): boolean =>
        at === names.length
          ? relation.real(Object.fromEntries(names.map((key, index) => [key, chosen[index]!])))
          : lists[at]!.every((one) => chosen.includes(one) || go(at + 1, [...chosen, one]));
      return go(0, []);
    };
  const rules = {
    definition: declared,
    names: [
      ...(declared ? Paths.invariantNames(declared) : []),
      ...relations.map((relation) => relation.name),
    ],
    relations,
    real: {
      ...((model.invariants ?? {}) as unknown as Record<string, (model: unknown) => boolean>),
      ...Object.fromEntries(relations.map((relation) => [relation.name, everywhere(relation)])),
    },
    later: declared ? Paths.namesOf(declared, "eventually") : [],
    realLater: (model.eventually ?? {}) as unknown as Record<string, (model: unknown) => boolean>,
  };
  unread.push(
    ...Object.keys(model.eventually ?? {})
      .filter((name) => !rules.later.includes(name))
      .map((name) => `${model.modelName}.${name}`),
  );
  // Only what something depends on is followed: a policy reacts to it, an invariant reads
  // it, or a view that is followed reads it.
  const wanted = new Set(
    views.filter(
      (view) => named.has(view.name) || policies.some((policy) => policy.from === view.cls),
    ),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const view of views)
      if (!wanted.has(view) && [...wanted].some((reader) => reader.sources.has(view.cls))) {
        wanted.add(view);
        grew = true;
      }
  }
  const folded = views.filter((view) => wanted.has(view));
  for (const view of views)
    if (!wanted.has(view))
      aside.push({
        kind: view.kind,
        name: view.name,
        reason: "no rule reads it and no policy reacts to it",
      });
  for (const stream of (model.definitions.streams ?? []) as ReadonlyArray<{
    readonly streamName: string;
  }>)
    aside.push({
      kind: "stream",
      name: stream.streamName,
      reason: "what a stream gives is not checked",
    });
  for (const query of (model.queries ?? []) as ReadonlyArray<{ readonly queryName: string }>)
    aside.push({
      kind: "query",
      name: query.queryName,
      reason: "what a query answers is not checked",
    });
  return {
    aggregates,
    decisions,
    missing,
    unread,
    policies,
    sagas,
    skipped,
    aside,
    rules,
    views: folded,
  };
});

export type Located = Effect.Success<ReturnType<typeof locate>>;

/**
 * Run every sequence of commands callers can send, up to `depth` of them, on
 * a model with nothing in it. After each command the policies react, and their
 * commands run before the next one a caller sends.
 */
export const search = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  located: Located,
  external: ReadonlyArray<unknown>,
  options: Options,
) {
  const aggs = located.aggregates;
  const byClass = new Map<unknown, Agg>(aggs.map((agg) => [agg.cls, agg]));
  const externals = aggs.flatMap((agg) =>
    agg.commands
      .filter((command) => external.includes(command))
      .map((command) => ({ agg, command })),
  );
  const decisions = located.decisions;
  /** The decisions callers can send the command of. */
  const decided = decisions.filter((decision) => external.includes(decision.command));

  /**
   * The invariants each command keeps whatever state it meets. A policy's
   * command is one of them, so the proofs cover what policies send too.
   */
  const dead: Array<string> = [];
  const kept = new Map<string, ReadonlySet<string>>();
  const unkept: Array<string> = [];
  // A decision is one more command of each aggregate it reads: it has to keep their
  // rules, and its own, from any states their schemas allow.
  const decisionRows = new Map<Decided, Induction.DecisionRow>();
  for (const decision of decisions) {
    const row = yield* Induction.decisionRow(solver, interpreter, decision);
    decisionRows.set(decision, row);
    unkept.push(...Induction.unkept([row]));
    if (row.accepted === false) dead.push(decision.name);
  }
  const readers = (agg: Agg) =>
    decisions.filter((decision) => Object.values(decision.aggs).includes(agg));
  /** The aggregates every command and every decision keeps in their schema: the proofs count for them. */
  const closed = new Set<Agg>();
  const ownRows = new Map<Agg, ReadonlyArray<Induction.Row>>();
  for (const agg of aggs) {
    const rows =
      agg.invariants.length === 0 && readers(agg).length === 0
        ? []
        : yield* Induction.rows(solver, interpreter, agg.cls, agg.definition);
    ownRows.set(agg, rows);
    unkept.push(...Induction.unkept(rows).map((line) => `${agg.name}.${line}`));
    for (const row of rows) if (row.accepted === false) dead.push(`${agg.name}.${row.command}`);
    if (
      Schema.is(agg.definition.state as Schema.Schema<unknown>)(agg.cls.definition.initial) &&
      Induction.closed(rows) &&
      readers(agg).every((decision) => decisionRows.get(decision)!.fits._tag === "Proved")
    )
      closed.add(agg);
  }
  for (const agg of aggs) {
    if (!closed.has(agg)) continue;
    for (const row of ownRows.get(agg)!)
      kept.set(
        `${agg.name}.${row.command}`,
        new Set(
          [...row.verdicts].flatMap(([name, verdict]) => (verdict._tag === "Proved" ? [name] : [])),
        ),
      );
    // A decision's proof starts from every instance it reads in its schema.
    for (const decision of readers(agg)) {
      if (!Object.values(decision.aggs).every((read) => closed.has(read))) continue;
      const row = decisionRows.get(decision)!;
      kept.set(
        `${agg.name}.${decision.name}`,
        new Set(
          agg.invariants.filter(
            (name) => row.verdicts.get(Induction.ruleOf(agg.name, name))?._tag === "Proved",
          ),
        ),
      );
    }
  }
  for (const decision of decisions) {
    if (!Object.values(decision.aggs).every((read) => closed.has(read))) continue;
    const row = decisionRows.get(decision)!;
    kept.set(
      decision.name,
      new Set(decision.own.filter((name) => row.verdicts.get(name)?._tag === "Proved")),
    );
  }
  /** Whether every command and every decision that can change what a rule is about keeps it. */
  const provedBy = (owner: string, name: string): boolean => {
    const agg = aggs.find((agg) => agg.name === owner);
    // A decision's own rule: its proof is the decision's.
    if (!agg) return kept.get(owner)?.has(name) === true;
    return (
      agg.commands.every((command) => kept.get(`${owner}.${command.tag}`)?.has(name) === true) &&
      readers(agg).every((decision) => kept.get(`${owner}.${decision.name}`)?.has(name) === true)
    );
  };
  /**
   * A relation's proof starts each instance from any state its aggregate's
   * invariants allow, so it counts only where each of those is proved: for its
   * own aggregates, and for the ones a decision on them reads.
   */
  const settled = (agg: Agg): boolean =>
    closed.has(agg) &&
    agg.invariants
      .filter((name) => !agg.transitions.has(name))
      .every((name) => provedBy(agg.name, name));
  const relationRows =
    located.rules.relations.length > 0 && located.rules.definition
      ? yield* Relations.rows(solver, interpreter, {
          model: located.rules.definition,
          relations: located.rules.relations,
          decisions,
        })
      : [];
  const provedRelations = new Set(
    relationRows.flatMap((row) => {
      const relation = located.rules.relations.find((one) => one.name === row.name)!;
      const touched = new Set<Agg>(relation.aggs);
      for (const decision of decisions)
        if (Object.values(decision.aggs).some((agg) => relation.aggs.includes(agg)))
          for (const agg of Object.values(decision.aggs)) touched.add(agg);
      return row.verdict._tag === "Proved" && [...touched].every(settled) ? [row.name] : [];
    }),
  );

  const pass = Effect.fn(function* (skipped: ReadonlyMap<string, Skipped>) {
    const policies = located.policies.filter((policy) => !skipped.has(policy.name));
    const sagas = located.sagas.filter((saga) => !skipped.has(saga.name));
    const outcomes = new Map<string, { -readonly [K in keyof Outcome]: Outcome[K] }>();
    const reached = new Map<string, { aggregate: string; tag: string; story: Story | undefined }>();
    const broken = new Map<string, { aggregate: string; name: string; story: Story | undefined }>();
    for (const agg of aggs) {
      for (const command of agg.commands) {
        for (const event of command.events)
          outcomes.set(`${agg.name}.${command.tag} records ${event.tag}`, {
            aggregate: agg.name,
            command: command.tag,
            kind: "records",
            tag: event.tag,
            story: undefined,
          });
        for (const rejection of command.rejects)
          outcomes.set(`${agg.name}.${command.tag} rejects ${rejection.tag}`, {
            aggregate: agg.name,
            command: command.tag,
            kind: "rejects",
            tag: rejection.tag,
            story: undefined,
          });
      }
      // A new instance is in its first state before any command.
      const first = tagOf(agg.initial);
      for (const tag of stateTags(agg.definition.state))
        reached.set(`${agg.name} ${tag}`, {
          aggregate: agg.name,
          tag,
          story: tag === first ? [] : undefined,
        });
      for (const name of agg.invariants) {
        const holds = agg.real[name];
        broken.set(`${agg.name}.${name}`, {
          aggregate: agg.name,
          name,
          // A new instance is the first state reached.
          story: holds && holds(agg.cls.definition.initial) !== true ? [] : undefined,
        });
      }
    }
    for (const decision of decisions) {
      for (const event of decision.command.events)
        outcomes.set(`${decision.name} records ${event.tag}`, {
          aggregate: undefined,
          command: decision.name,
          kind: "records",
          tag: event.tag,
          story: undefined,
        });
      for (const rejection of decision.command.rejects)
        outcomes.set(`${decision.name} rejects ${rejection.tag}`, {
          aggregate: undefined,
          command: decision.name,
          kind: "rejects",
          tag: rejection.tag,
          story: undefined,
        });
      for (const name of decision.own)
        broken.set(`${decision.name}.${name}`, {
          aggregate: decision.name,
          name,
          story: undefined,
        });
    }
    const ruled = new Map<string, Story | undefined>(
      located.rules.names.map((name) => [name, undefined]),
    );
    const ended = new Map<string, Story | undefined>(
      located.rules.later.map((name) => [name, undefined]),
    );
    const failures = new Map<string, { policy: string; tag: string; story: Story }>();
    const endings = new Map<string, { saga: string; ending: string; story: Story | undefined }>();
    for (const saga of sagas)
      for (const ending of ["completes", ...saga.rejects.map((tag) => `fails with ${tag}`)])
        endings.set(`${saga.name} ${ending}`, { saga: saga.name, ending, story: undefined });
    const followed = new Set<string>();
    const called = new Set<string>();
    const repeated = new Set<string>();
    const started = new Set<string>();
    const unread = new Map<string, Value.NotTranslated>();
    const disagreements = new Set<string>();
    const undecided = new Map<string, number>();
    const gaveUp = (reason: string) => undecided.set(reason, (undecided.get(reason) ?? 0) + 1);
    let states = 0;
    const looked = new Map<string, number>();
    const look = (name: string) => looked.set(name, (looked.get(name) ?? 0) + 1);
    let unsettled = 0;
    let sequences = 0;
    let truncated = false;

    /**
     * Whether a story of `length` commands in the sequence being looked at
     * beats the one kept. Fewer moves beat fewer commands: a story is what a
     * caller has to do. Sequences run in order of their moves, so one kept
     * from an earlier round already has fewer.
     */
    let moving = 0;
    const shorter = (story: Story | undefined, length: number) =>
      !story ||
      (story.length > length &&
        story.filter((step) => step.by === undefined || step.after !== undefined).length ===
          moving);

    /** A sequence that can happen and can go on. */
    interface Open {
      readonly run: Value.Run;
      readonly trail: ReadonlyArray<Entry>;
      readonly instances: ReadonlyArray<Instance>;
      readonly views: ReadonlyArray<ViewSlot>;
      readonly fed: ReadonlyArray<Fed>;
      readonly calls: ReadonlyArray<Call>;
      readonly receipts: ReadonlyMap<string, Receipt>;
      readonly armed: ReadonlyMap<string, V>;
      readonly decisions: ReadonlyMap<string, Paths.Decided>;
      readonly sagas: ReadonlyArray<SagaRun>;
      readonly timers: ReadonlyArray<Timer>;
      /** The commands callers sent and the schedules that came due. */
      readonly length: number;
    }

    const begin = (from: Open): Sequence => ({
      trail: [...from.trail],
      instances: [...from.instances],
      views: [...from.views],
      fed: [...from.fed],
      calls: [...from.calls],
      receipts: new Map(from.receipts),
      armed: new Map(from.armed),
      decisions: new Map(from.decisions),
      queue: [],
      sagas: [...from.sagas],
      timers: [...from.timers],
      failures: [],
      endings: [],
      unsettled: false,
      moved: false,
      reran: false,
      ran: { policies: new Set(), sagas: new Set(), systems: new Set(), repeated: new Set() },
      rules: [],
      later: [],
    });
    const nothing: Open = {
      run: new Value.Run([]),
      trail: [],
      instances: [],
      views: [],
      fed: [],
      calls: [],
      receipts: new Map(),
      armed: new Map(),
      decisions: new Map(),
      sagas: [],
      timers: [],
      length: 0,
    };

    /**
     * The sequence being run, the policy or saga reacting in it, the saga's
     * run in progress, and an aggregate's code that stopped it.
     */
    let sequence = begin(nothing);
    let reacting: string | undefined;
    /** The delivery a policy is handling, and how many commands it has sent or scheduled for it. */
    let delivering: Scope | undefined;
    /** The saga step in progress, and how many commands it has sent or scheduled. */
    let stepping: Scope | undefined;
    /** What gives the commands being sent their ids: the step of a saga, or the delivery of an event. */
    const scopeOf = (): Scope | undefined => (working ? stepping : delivering);
    let working:
      | {
          /** Names the run: the commands its steps send get ids from it. */
          readonly id: string;
          readonly journal: Map<string, Journaled>;
          readonly signals: ReadonlyMap<string, V>;
          /** What to run when the run ends, last registered first. */
          readonly finalizers: Array<V>;
          /** Rejections already reported as a failure. */
          readonly flagged: Set<V>;
          waiting: string | undefined;
        }
      | undefined;
    let stopped: Value.Stop | undefined;

    /**
     * A value built from other inputs, as an input of its own that equals it:
     * the solver then says what it is, and the story can show it.
     */
    const pin = (value: V, name: string): V => {
      const run = interpreter.current.run;
      const constant = (term: Smt.Term): Smt.Term => {
        if (run.declarations.has(term.text)) return term;
        const made = run.constant(name, term.sort);
        run.assume(`(= ${made.text} ${term.text})`);
        return made;
      };
      switch (value._tag) {
        case "Term":
          return { _tag: "Term", term: constant(value.term) };
        case "Time":
          return { _tag: "Time", millis: constant(value.millis) };
        case "Obj":
          return Value.obj(
            Object.fromEntries(
              Object.entries(value.fields).map(([key, field]) => [
                key,
                pin(field, `${name}.${key}`),
              ]),
            ),
            value.brand,
          );
        case "Arr":
          return {
            _tag: "Arr",
            items: value.items.map((item, index) => pin(item, `${name}.${index}`)),
          };
        default:
          return value;
      }
    };

    /**
     * A view's handler for an event: the one under the event's tag, or under
     * its source's name, and for a view with routes, the one of the route.
     */
    const handlerOf: (
      view: ViewImpl,
      key: string,
      tag: string,
      origin: string,
      route: string | undefined,
    ) => Eval<V | undefined> = Effect.fnUntraced(function* (
      view: ViewImpl,
      key: string,
      tag: string,
      origin: string,
      route: string | undefined,
    ) {
      const site: Site = { module: view.definition.module, node: view.definition.node };
      const all = yield* Paths.handlers(interpreter, view.definition, key);
      for (const name of [tag, origin]) {
        const found = yield* interpreter.member(all, name, site);
        if (found._tag === "Undef") continue;
        if (found._tag !== "Obj") return found;
        if (route === undefined) return undefined;
        const routed = yield* interpreter.member(found, route, site);
        return routed._tag === "Undef" ? undefined : routed;
      }
      return undefined;
    });

    /** The id a route gave: a ref's, or the value of a key that is one. */
    const idOf = (reached: V): V | undefined =>
      reached._tag === "Undef" || reached._tag === "Null"
        ? undefined
        : reached._tag === "Obj" && reached.fields.id
          ? reached.fields.id
          : reached;

    /** The keys of a view an event goes to, as the kernel routes it: by `keyOf`, or to its own source. */
    const routesOf: (
      view: ViewImpl,
      tag: string,
      origin: string,
      routing: V,
      source: V,
    ) => Eval<ReadonlyArray<{ readonly route: string | undefined; readonly key: V }>> =
      Effect.fnUntraced(function* (
        view: ViewImpl,
        tag: string,
        origin: string,
        routing: V,
        source: V,
      ) {
        const site: Site = { module: view.definition.module, node: view.definition.node };
        const all = yield* Paths.handlers(interpreter, view.definition, "keyOf");
        let custom: V | undefined;
        for (const name of [tag, origin]) {
          const found = yield* interpreter.member(all, name, site);
          if (found._tag === "Undef") continue;
          custom = found;
          break;
        }
        const made: Array<{ route: string | undefined; key: V }> = [];
        if (!custom) {
          const key = idOf(source);
          if (key) made.push({ route: undefined, key });
        } else if (custom._tag === "Obj") {
          for (const [route, pick] of Object.entries(custom.fields)) {
            const key = idOf(yield* interpreter.call(pick, [routing], site));
            if (key) made.push({ route, key });
          }
        } else {
          const key = idOf(yield* interpreter.call(custom, [routing], site));
          if (key) made.push({ route: undefined, key });
        }
        for (const { key } of made)
          if (textOf(key) === undefined)
            return yield* Value.notTranslated(
              site,
              `${view.name} routes ${tag} to a key the explorer cannot follow`,
            );
        return made;
      });

    /** Whether a view takes an event from a source at all, as the kernel decides it. */
    const consumes = (view: ViewImpl, tag: string, origin: string, cls: unknown): boolean => {
      if (view.kind === "projection") return view.on.includes(cls);
      const def = view.cls.definition;
      return Boolean(
        def.evolve?.[tag] ||
        def.evolve?.[origin] ||
        def.emit?.[tag] ||
        def.emit?.[origin] ||
        view.declared?.has(tag),
      );
    };

    /**
     * Give one event to a view, as the kernel does: route it to its keys, and
     * for each `evolve`, then `emit` with the state before and after. The
     * policies and views that read the view get what it emits.
     */
    const fold: (
      view: ViewImpl,
      origin: unknown,
      source: V,
      state: V,
      event: V,
      at: number,
    ) => Eval<void> = Effect.fnUntraced(function* (
      view: ViewImpl,
      origin: unknown,
      source: V,
      state: V,
      event: V,
      at: number,
    ) {
      const site: Site = { module: view.definition.module, node: view.definition.node };
      const tag = tagOf(event);
      const from = view.sources.get(origin);
      const cls = event._tag === "Obj" ? event.brand?.cls : undefined;
      if (tag === undefined || from === undefined || !consumes(view, tag, from, cls)) return;
      const entry = sequence.trail[at]!;
      const envelope = Value.obj({
        id: idOf(source) ?? Value.undef,
        at: entry.inputs.now,
        commandId: entry.inputs.commandId,
        correlationId: entry.inputs.commandId,
      });
      const routing = Value.obj({ event, source, state, envelope });
      const tags: Array<string> = [];
      for (const { route, key } of yield* routesOf(view, tag, from, routing, source)) {
        const ref =
          view.keyedBy === undefined
            ? key
            : Value.obj({ aggregate: Value.str(view.keyedBy), id: key });
        if (view.kind === "projection") {
          sequence.fed.push({ view, key, event, state });
          tags.push(tag);
          continue;
        }
        const context = { key: ref, source, state, envelope, at: entry.inputs.now };
        const where = sequence.views.findIndex((slot) => slot.view === view && same(slot.key, key));
        const current = where < 0 ? undefined : sequence.views[where]!.state;
        const before = view.stateful ? (current ?? view.initial) : Value.nil;
        const evolve = view.stateful
          ? yield* handlerOf(view, "evolve", tag, from, route)
          : undefined;
        let after = current;
        if (evolve) {
          const made = yield* interpreter.call(evolve, [before, event, Value.obj(context)], site);
          after = made._tag === "Null" || made._tag === "Undef" ? undefined : made;
          const next: ViewSlot = { view, key, state: after };
          if (where < 0) sequence.views.push(next);
          else sequence.views[where] = next;
        }
        const emit = yield* handlerOf(view, "emit", tag, from, route);
        const made = !view.declared
          ? evolve
            ? [event]
            : []
          : emit
            ? yield* interpreter
                .call(
                  emit,
                  [event, Value.obj({ ...context, before, after: after ?? Value.nil })],
                  site,
                )
                .pipe(Effect.map((out) => (out._tag === "Arr" ? out.items : [out])))
            : view.declared.has(tag)
              ? [event]
              : [];
        const emitted = made.filter((out) => out._tag !== "Undef");
        tags.push(...emitted.map((out) => tagOf(out) ?? "?"));
        for (const [nth, out] of emitted.entries()) {
          const emittedClass = out._tag === "Obj" ? out.brand?.cls : undefined;
          for (const policy of policies)
            if (policy.from === view.cls && policy.on.includes(emittedClass))
              sequence.queue.push({
                policy,
                source: ref,
                id: key,
                event: out,
                parent: at,
                state: after ?? Value.nil,
                key: `${at}/${view.name}/${route ?? ""}/${tag}/${nth}/${policy.name}/${sequence.queue.length}`,
              });
          for (const reader of located.views)
            if (reader.sources.has(view.cls))
              yield* fold(reader, view.cls, ref, after ?? Value.nil, out, at);
        }
      }
      entry.emitted.push({ view, tags });
    });

    /**
     * Call an external system: the explorer does not know what it answers,
     * so the answer is an input, and the solver picks it. Each error the
     * operation declares is a path of its own.
     */
    const answer = (
      cls: SystemClass,
      op: string,
      spec: ExternalSystem.OpSpec,
      site: Site,
    ): Eval<V> => {
      const run = interpreter.current.run;
      const errors: ReadonlyArray<unknown> =
        spec.error === undefined
          ? []
          : Array.isArray(spec.error)
            ? (spec.error as ReadonlyArray<unknown>)
            : [spec.error];
      const picked = errors.length === 0 ? 0 : run.choose(errors.length + 1);
      const schema = picked === 0 ? ExternalSystem.successSchema(spec) : errors[picked - 1];
      // A class's own type is opaque to the solver: its fields are what an answer is made of.
      const fields = (schema as { readonly fields?: Schema.Struct.Fields } | undefined)?.fields;
      const ast = Symbolic.typeOf(fields ? Schema.Struct(fields) : schema);
      const call = `${cls.systemName}.${op}`;
      if (!ast)
        return Effect.fail(Value.notTranslated(site, `${call} answers something with no schema`));
      const value = Symbolic.symbolic(ast, `answer${sequence.calls.length + 1}.${call}`, run);
      sequence.calls.push({
        at: sequence.trail.length,
        by: reacting,
        call,
        op: (cls as unknown as Readonly<Record<string, unknown>>)[op],
        answer: value,
        failed: picked !== 0,
        again: scopeOf()?.again === true,
        step: scopeOf()?.step,
      });
      sequence.ran.systems.add(cls.systemName);
      if (scopeOf()?.again)
        sequence.ran.repeated.add(
          `${call}, by ${reacting}${scopeOf()?.step === undefined ? "" : ` in its step ${scopeOf()?.step}`}`,
        );
      return picked === 0
        ? Effect.succeed(value)
        : Effect.fail(new Value.Rejected({ rejection: value }));
    };
    const systems = new Map<unknown, V>();
    const systemOf = (cls: SystemClass): V => {
      const made =
        systems.get(cls) ??
        Value.obj(
          Object.fromEntries(
            Object.entries(cls.ops).map(([op, spec]) => [
              op,
              native(`${cls.systemName}.${op}`, (_, site) =>
                Effect.succeed<V>({
                  _tag: "Effect",
                  run: Effect.suspend(() => answer(cls, op, spec, site)),
                }),
              ),
            ]),
          ),
        );
      systems.set(cls, made);
      return made;
    };

    /** Send one command to an instance, in the run of the current sequence. */
    const apply: (
      agg: Agg,
      index: number,
      command: CommandClass,
      given: V | undefined,
      timer?: Timer,
    ) => Eval<Paths.Applied> = Effect.fnUntraced(
      function* (
        agg: Agg,
        index: number,
        command: CommandClass,
        given: V | undefined,
        timer?: Timer,
      ) {
        const run = interpreter.current.run;
        const label = `${sequence.trail.length + 1}.`;
        // Time does not run backwards between commands.
        const now = run.constant(`${label}now`, "Int");
        const previous = sequence.trail[sequence.trail.length - 1];
        if (previous) run.assume(`(>= ${now.text} ${Smt.symbol(`${previous.label}now`)})`);
        // A scheduled command runs once its delay has passed.
        if (timer) run.assume(`(>= ${now.text} (+ ${timer.since} ${timer.millis}))`);
        const sent = {
          by: timer ? timer.by : reacting,
          after: timer?.after,
          again: !timer && scopeOf()?.again === true,
          step: timer ? undefined : scopeOf()?.step,
          pending: sequence.timers.map((waiting) => ({
            since: waiting.since,
            millis: waiting.millis,
          })),
        };
        const instance = sequence.instances[index]!;
        const step = yield* Paths.step(
          interpreter,
          agg.definition,
          command,
          instance.state,
          Value.num(instance.version),
          label,
          {
            id: instance.id,
            ...(given ? { given } : {}),
          },
        );
        const applied = step.applied;
        const at = sequence.trail.length;
        if (applied._tag !== "Changed") {
          sequence.trail.push({
            agg,
            instance: index,
            command,
            label,
            inputs: step.inputs,
            applied,
            checks: [],
            emitted: [],
            ...sent,
          });
          return applied;
        }
        const checks =
          agg.invariants.length > 0
            ? yield* Paths.checks(
                interpreter,
                agg.definition,
                applied.state,
                {
                  before: instance.state,
                  command: step.inputs.command,
                  events: applied.events,
                },
                kept.get(`${agg.name}.${command.tag}`),
              )
            : [];
        sequence.instances[index] = {
          ...instance,
          state: applied.state,
          version: instance.version + applied.events.length,
        };
        sequence.trail.push({
          agg,
          instance: index,
          command,
          label,
          inputs: step.inputs,
          applied,
          checks,
          emitted: [],
          ...sent,
        });
        for (const [nth, event] of applied.events.entries()) {
          const cls = event._tag === "Obj" ? event.brand?.cls : undefined;
          for (const policy of policies)
            if (policy.from === agg.cls && policy.on.includes(cls))
              sequence.queue.push({
                policy,
                source: Value.obj({ aggregate: Value.str(agg.name), id: instance.id }),
                id: instance.id,
                event,
                parent: at,
                key: `${at}/${nth}/${policy.name}`,
              });
          for (const view of located.views)
            if (view.sources.has(agg.cls))
              yield* fold(
                view,
                agg.cls,
                Value.obj({ aggregate: Value.str(agg.name), id: instance.id }),
                Value.undef,
                event,
                at,
              );
        }
        return applied;
      },
      Effect.tapError((error) =>
        Effect.sync(() => {
          stopped = error;
        }),
      ),
    );

    /** The instance a policy's command goes to: one there already, or a new one. */
    const resolve = (agg: Agg, address: V, text: string): number => {
      const run = interpreter.current.run;
      for (const [index, instance] of sequence.instances.entries()) {
        if (instance.agg !== agg) continue;
        const other = textOf(instance.id)!;
        if (text === other) return index;
        if (address._tag === "Str" && instance.id._tag === "Str") continue;
        if (run.branch(`(= ${text} ${other})`)) return index;
      }
      const made = sequence.instances.filter((instance) => instance.agg === agg).length + 1;
      const ast = Symbolic.typeOf(agg.cls.definition.id);
      if (ast) Symbolic.assumeFits(address, ast, run);
      sequence.instances.push({
        agg,
        id: pin(address, `${agg.name}#${made}.id`),
        state: agg.initial,
        version: 0,
      });
      return sequence.instances.length - 1;
    };

    /** Decide one command across the instances it names, in the run of the current sequence. */
    const applyDecision: (
      decision: Decided,
      given: V | undefined,
      /** A caller sent it: it names no more instances of an aggregate than a caller addresses. */
      capped: boolean,
    ) => Eval<Paths.Decided> = Effect.fnUntraced(
      function* (decision: Decided, given: V | undefined, capped: boolean) {
        const run = interpreter.current.run;
        const label = `${sequence.trail.length + 1}.`;
        const now = run.constant(`${label}now`, "Int");
        const previous = sequence.trail[sequence.trail.length - 1];
        if (previous) run.assume(`(>= ${now.text} ${Smt.symbol(`${previous.label}now`)})`);
        const sent = {
          by: reacting,
          after: undefined,
          again: scopeOf()?.again === true,
          step: scopeOf()?.step,
          pending: sequence.timers.map((waiting) => ({
            since: waiting.since,
            millis: waiting.millis,
          })),
        };
        const site: Site = { module: decision.definition.module, node: decision.definition.node };
        const slotOf = Effect.fnUntraced(function* (name: string, id: V) {
          const agg = decision.aggs[name];
          const text = textOf(id);
          if (!agg || text === undefined)
            return yield* Value.notTranslated(
              site,
              `${decision.name} reads ${name} by something that is not an id`,
            );
          const index = resolve(agg, id, text);
          if (
            capped &&
            sequence.instances.filter((instance) => instance.agg === agg).length > options.instances
          )
            return yield* new Value.Infeasible();
          const instance = sequence.instances[index]!;
          const slot: Paths.Slot = {
            definition: agg.definition,
            id: instance.id,
            state: instance.state,
            version: Value.num(instance.version),
          };
          return { index, slot };
        });
        const step = yield* Paths.decided(
          interpreter,
          decision.definition,
          decision.command,
          label,
          slotOf,
          given,
        );
        const applied = step.applied;
        const at = sequence.trail.length;
        /** The instance behind each slot the decision read. */
        const instanceOf = (slot: number): number => {
          const read = step.slots[slot]!;
          return sequence.instances.findIndex(
            (instance) =>
              instance.agg.definition === read.definition &&
              textOf(instance.id) === textOf(read.id),
          );
        };
        const first = step.slots[0];
        const head = first ? instanceOf(0) : -1;
        const agg = head >= 0 ? sequence.instances[head]!.agg : Object.values(decision.aggs)[0]!;
        const base = {
          agg,
          instance: head,
          command: decision.command,
          label,
          inputs: {
            state: first?.state ?? Value.undef,
            command: step.inputs.command,
            id: first?.id ?? Value.undef,
            commandId: step.inputs.commandId,
            version: first?.version ?? Value.num(0),
            now: step.inputs.now,
          },
          emitted: [],
          ...sent,
        };
        if (applied._tag !== "Changed") {
          sequence.trail.push({
            ...base,
            applied,
            checks: [],
            decided: { decision, parts: [], own: [] },
          });
          return applied;
        }
        const parts: Array<EntryPart> = [];
        for (const part of applied.parts) {
          const index = instanceOf(part.slot);
          const instance = sequence.instances[index]!;
          parts.push({
            agg: instance.agg,
            instance: index,
            events: part.events,
            state: part.state,
            checks:
              instance.agg.invariants.length > 0
                ? yield* Paths.checks(
                    interpreter,
                    instance.agg.definition,
                    part.state,
                    { before: part.before, command: step.inputs.command, events: part.events },
                    kept.get(`${instance.agg.name}.${decision.name}`),
                  )
                : [],
          });
        }
        const own = (yield* Paths.decisionChecks(interpreter, decision.definition, step)).filter(
          (check) => !kept.get(decision.name)?.has(check.name),
        );
        for (const part of parts) {
          const instance = sequence.instances[part.instance]!;
          sequence.instances[part.instance] = {
            ...instance,
            state: part.state,
            version: instance.version + part.events.length,
          };
        }
        sequence.trail.push({
          ...base,
          applied: {
            _tag: "Changed",
            events: applied.events,
            state: parts[0]?.state ?? Value.undef,
          },
          checks: [],
          decided: { decision, parts, own },
        });
        let nth = 0;
        for (const part of parts) {
          const instance = sequence.instances[part.instance]!;
          const source = Value.obj({ aggregate: Value.str(part.agg.name), id: instance.id });
          for (const event of part.events) {
            const cls = event._tag === "Obj" ? event.brand?.cls : undefined;
            for (const policy of policies)
              if (policy.from === part.agg.cls && policy.on.includes(cls))
                sequence.queue.push({
                  policy,
                  source,
                  id: instance.id,
                  event,
                  parent: at,
                  key: `${at}/${nth}/${policy.name}`,
                });
            nth++;
            for (const view of located.views)
              if (view.sources.has(part.agg.cls))
                yield* fold(view, part.agg.cls, source, Value.undef, event, at);
          }
        }
        return applied;
      },
      Effect.tapError((error) =>
        Effect.sync(() => {
          stopped = error;
        }),
      ),
    );

    /** A policy or a saga sends the command a decision implements. */
    const sendDecision: (decision: Decided, command: V | undefined, site: Site) => Eval<V> =
      Effect.fnUntraced(function* (decision: Decided, command: V | undefined, site: Site) {
        if (
          command?._tag !== "Obj" ||
          command.brand?.kind !== "Command" ||
          command.brand.cls !== decision.command
        )
          return yield* Value.notTranslated(
            site,
            `sends ${decision.name} something that is not its command`,
          );
        // Sent again by the same delivery, it gives what it gave the first time.
        const scope = scopeOf();
        const slot = scope ? `${scope.key}#${scope.ordinal++}` : undefined;
        const before = slot === undefined ? undefined : sequence.decisions.get(slot);
        const applied =
          before ??
          (yield* applyDecision(
            decision,
            pin(command, `${sequence.trail.length + 1}.command`),
            false,
          ));
        if (slot !== undefined && !before && applied._tag !== "Rejected")
          sequence.decisions.set(slot, applied);
        if (scope && applied._tag === "Rejected") scope.refused = true;
        if (applied._tag === "Rejected")
          return yield* new Value.Rejected({ rejection: applied.rejection });
        return Value.obj({
          commits: { _tag: "Arr", items: [] },
          events: { _tag: "Arr", items: applied._tag === "Changed" ? [...applied.events] : [] },
          reply: Value.undef,
        });
      });

    /** A command and where it goes, as a policy or saga wrote them. */
    const addressed = Effect.fnUntraced(function* (
      agg: Agg,
      command: V | undefined,
      site: Site,
      verb: string,
    ) {
      const cls =
        command?._tag === "Obj" && command.brand?.kind === "Command"
          ? (command.brand.cls as CommandClass)
          : undefined;
      if (!command || !cls)
        return yield* Value.notTranslated(
          site,
          `${verb} ${agg.name} something that is not a command`,
        );
      if (!agg.commands.includes(cls))
        return yield* Value.notTranslated(
          site,
          `${verb} ${cls.tag} to ${agg.name}, which does not take it`,
        );
      // The command's input names its instance, as the aggregate's `keyOf` reads it.
      const address = yield* Paths.keyOf(interpreter, agg.definition, command);
      const text = textOf(address);
      if (text === undefined)
        return yield* Value.notTranslated(
          site,
          `${verb} ${cls.tag} to an address the explorer cannot follow`,
        );
      return { cls, command, address, text };
    });

    /** Whether two addresses are the same one. Symbolic ones split the path. */
    const same = (a: V, b: V): boolean => {
      const [left, right] = [textOf(a)!, textOf(b)!];
      if (left === right) return true;
      if (a._tag === "Str" && b._tag === "Str") return false;
      return interpreter.current.run.branch(`(= ${left} ${right})`);
    };

    const send: (agg: Agg, command: V | undefined, site: Site) => Eval<V> = Effect.fnUntraced(
      function* (agg: Agg, command: V | undefined, site: Site) {
        const to = yield* addressed(agg, command, site, "sends");
        const index = resolve(agg, to.address, to.text);
        // A command's id comes from the delivery and its place in it: the instance that
        // took it once gives the same answer again, and does nothing more.
        const scope = scopeOf();
        const slot = scope ? `${scope.key}#${scope.ordinal++}` : undefined;
        const before = slot === undefined ? undefined : sequence.receipts.get(slot);
        const applied =
          before && before.instance === index
            ? before.applied
            : yield* apply(
                agg,
                index,
                to.cls,
                pin(to.command, `${sequence.trail.length + 1}.command`),
              );
        // The kernel keeps what a command gave only once the command is taken: one it
        // refused is decided again, on the state the instance has by then.
        if (slot !== undefined && !before && applied._tag !== "Rejected")
          sequence.receipts.set(slot, { instance: index, applied });
        if (scope && applied._tag === "Rejected") scope.refused = true;
        if (applied._tag === "Rejected")
          return yield* new Value.Rejected({ rejection: applied.rejection });
        return Value.obj({
          version: Value.num(sequence.instances[index]!.version),
          events: { _tag: "Arr", items: applied._tag === "Changed" ? applied.events : [] },
          reply: Value.undef,
        });
      },
    );

    /** Keep a command for later. It runs as a step of its own once its delay has passed. */
    const schedule: (
      agg: Agg,
      command: V | undefined,
      options: V | undefined,
      site: Site,
    ) => Eval<V> = Effect.fnUntraced(function* (
      agg: Agg,
      command: V | undefined,
      options: V | undefined,
      site: Site,
    ) {
      const to = yield* addressed(agg, command, site, "schedules");
      // The same arming again, by a policy handling its event again: it stays as it is.
      const scope = scopeOf();
      const slot = scope ? `${scope.key}#${scope.ordinal++}` : undefined;
      const armed = slot === undefined ? undefined : sequence.armed.get(slot);
      if (armed) return armed;
      const fields = options?._tag === "Obj" ? options.fields : {};
      const wait = fields.after;
      const millis =
        wait?._tag === "Num"
          ? wait.value
          : wait?._tag === "Str"
            ? Option.getOrUndefined(
                Option.map(Duration.fromInput(wait.value as Duration.Input), Duration.toMillis),
              )
            : undefined;
      const last = sequence.trail[sequence.trail.length - 1];
      const named = fields.commandId;
      if (
        millis === undefined ||
        !last ||
        (named !== undefined && named._tag !== "Str" && named._tag !== "Undef")
      )
        return yield* Value.notTranslated(
          site,
          `schedules ${to.cls.tag} in a way the explorer cannot follow`,
        );
      const commandId = named?._tag === "Str" ? named.value : to.cls.tag;
      const since = Smt.symbol(`${last.label}now`);
      // Scheduling again under the same command id replaces the one before.
      sequence.timers = sequence.timers.filter(
        (timer) =>
          !(timer.agg === agg && timer.commandId === commandId && same(timer.address, to.address)),
      );
      sequence.timers.push({
        agg,
        address: to.address,
        command: pin(
          to.command,
          `${sequence.trail.length}.${agg.name}.${commandId}.scheduled#${interpreter.current.run.declarations.size}`,
        ),
        cls: to.cls,
        commandId,
        since,
        millis,
        after: wait?._tag === "Str" ? wait.value : `${millis} ms`,
        by: reacting,
      });
      const receipt = Value.obj({
        commandId: Value.str(commandId),
        at: { _tag: "Time", millis: { sort: "Int", text: `(+ ${since} ${millis})` } },
      });
      if (slot !== undefined) sequence.armed.set(slot, receipt);
      return receipt;
    });

    const unschedule: (agg: Agg, target: V | undefined, id: V | undefined, site: Site) => Eval<V> =
      Effect.fnUntraced(function* (agg: Agg, target: V | undefined, id: V | undefined, site: Site) {
        const address = target?._tag === "Obj" ? target.fields.id : target;
        if (!address || textOf(address) === undefined || id?._tag !== "Str")
          return yield* Value.notTranslated(
            site,
            "unschedules a command the explorer cannot follow",
          );
        sequence.timers = sequence.timers.filter(
          (timer) =>
            !(timer.agg === agg && timer.commandId === id.value && same(timer.address, address)),
        );
        return Value.undef;
      });

    const effect = (run: () => Eval<V>): V => ({ _tag: "Effect", run: Effect.suspend(run) });
    const finish = (made: V): Eval<V> => (made._tag === "Effect" ? made.run : Effect.succeed(made));

    const refuse = (name: string, reason: string): V =>
      native(name, (_, site) => Effect.fail(Value.notTranslated(site, reason)));

    const clients = new Map<Agg, V>(
      aggs.map((agg) => [
        agg,
        Value.obj({
          send: native(`${agg.name}.send`, ([command], site) =>
            Effect.succeed<V>({
              _tag: "Effect",
              run: Effect.suspend(() => send(agg, command, site)),
            }),
          ),
          schedule: native(`${agg.name}.schedule`, ([command, options], site) =>
            Effect.succeed(effect(() => schedule(agg, command, options, site))),
          ),
          unschedule: native(`${agg.name}.unschedule`, ([target, id], site) =>
            Effect.succeed(effect(() => unschedule(agg, target, id, site))),
          ),
          get: refuse(
            `${agg.name}.get`,
            `reads the state of ${agg.name}, which the explorer does not follow yet`,
          ),
        }),
      ]),
    );
    /** The run of a saga under a key, if a policy has started or signalled one. */
    const runOf = (saga: SagaImpl, key: V): number | undefined => {
      for (const [index, entry] of sequence.sagas.entries())
        if (entry.saga === saga && same(entry.key, key)) return index;
      return undefined;
    };
    const keyOf = (target: V | undefined): V | undefined =>
      target?._tag === "Obj" && target.fields.id ? target.fields.id : target;
    const signalOf = (deferred: V | undefined): string | undefined => {
      const name =
        deferred?._tag === "Host"
          ? (deferred.value as { readonly name?: unknown } | null)?.name
          : undefined;
      return typeof name === "string" ? name : undefined;
    };

    /** Give a run a signal. A run waiting for it goes on; one that has ended ignores it. */
    const signal = (
      saga: SagaImpl,
      key: V,
      deferred: V | undefined,
      value: V | undefined,
      site: Site,
    ): Eval<V> => {
      const name = signalOf(deferred);
      if (name === undefined || !value)
        return Effect.fail(
          Value.notTranslated(site, `signals ${saga.name} in a way the explorer cannot follow`),
        );
      const index = runOf(saga, key);
      const entry = index === undefined ? undefined : sequence.sagas[index]!;
      if (index === undefined || !entry) {
        // The signal came before the run: the run finds it when it starts.
        sequence.sagas.push({
          saga,
          key,
          input: undefined,
          journal: new Map(),
          signals: new Map([[name, value]]),
          waiting: undefined,
          done: false,
        });
        return Effect.succeed(Value.undef);
      }
      if (entry.done || entry.signals.has(name)) return Effect.succeed(Value.undef);
      sequence.sagas[index] = {
        ...entry,
        signals: new Map([...entry.signals, [name, value]]),
        waiting: entry.waiting === name ? undefined : entry.waiting,
      };
      if (entry.waiting === name) sequence.queue.push({ resume: index });
      return Effect.succeed(Value.undef);
    };

    const handle = (saga: SagaImpl, key: V): V =>
      Value.obj({
        signal: native(`${saga.name}.signal`, ([deferred, value], site) =>
          Effect.succeed(effect(() => signal(saga, key, deferred, value, site))),
        ),
        status: refuse(
          `${saga.name}.status`,
          `reads the status of ${saga.name}, which the explorer does not follow`,
        ),
        result: refuse(
          `${saga.name}.result`,
          `waits for the result of ${saga.name}, which the explorer does not follow`,
        ),
        interrupt: refuse(
          `${saga.name}.interrupt`,
          `interrupts ${saga.name}, which the explorer does not follow`,
        ),
      });

    /** Start a run. Starting one that has started does nothing. */
    const start = (
      saga: SagaImpl,
      target: V | undefined,
      input: V | undefined,
      site: Site,
    ): Eval<V> => {
      const key = keyOf(target);
      if (!key || textOf(key) === undefined || input?._tag !== "Obj")
        return Effect.fail(
          Value.notTranslated(site, `starts ${saga.name} in a way the explorer cannot follow`),
        );
      const index = runOf(saga, key);
      const existing = index === undefined ? undefined : sequence.sagas[index];
      if (existing?.input === undefined) {
        const at = index ?? sequence.sagas.length;
        sequence.sagas[at] = {
          saga,
          key: existing?.key ?? key,
          input,
          journal: new Map(),
          signals: existing?.signals ?? new Map(),
          waiting: undefined,
          done: false,
        };
        sequence.queue.push({ resume: at });
      }
      return Effect.succeed(handle(saga, key));
    };

    const sagaClients = new Map<unknown, V>(
      sagas.map((saga) => [
        saga.cls,
        Value.obj({
          start: native(`${saga.name}.start`, ([target, input], site) =>
            Effect.succeed(effect(() => start(saga, target, input, site))),
          ),
          get: native(`${saga.name}.get`, ([target], site) => {
            const key = keyOf(target);
            return key && textOf(key) !== undefined
              ? Effect.succeed(handle(saga, key))
              : Effect.fail(
                  Value.notTranslated(
                    site,
                    `gets a run of ${saga.name} the explorer cannot follow`,
                  ),
                );
          }),
        }),
      ]),
    );

    interpreter.hooks.service = (host) => {
      const agg = byClass.get(host);
      if (agg) return clients.get(agg);
      const decision = decisions.find((decision) => decision.cls === host);
      if (decision)
        return Value.obj({
          send: native(`${decision.name}.send`, ([command], site) =>
            Effect.succeed(effect(() => sendDecision(decision, command, site))),
          ),
        });
      const saga = sagaClients.get(host);
      if (saga) return saga;
      const kind =
        typeof host === "function" ? (host as { readonly kind?: unknown }).kind : undefined;
      return kind === "Saga"
        ? { _tag: "Opaque", what: "a saga" }
        : kind === "ExternalSystem"
          ? systemOf(host as SystemClass)
          : undefined;
    };

    // An activity runs once: a run that goes on after a signal reads what it gave.
    interpreter.hooks.models.set("effect/workflow:Activity.make", ([given], site) => {
      const fields = given?._tag === "Obj" ? given.fields : undefined;
      const name = fields?.name;
      const execute = fields?.execute;
      if (!fields || name?._tag !== "Str" || execute?._tag !== "Effect")
        return Effect.fail(
          Value.notTranslated(site, "makes an activity the explorer cannot follow"),
        );
      const declares = fields.error !== undefined && fields.error._tag !== "Undef";
      return Effect.succeed(
        effect(() => {
          const frame = working;
          if (!frame) return execute.run;
          const before = frame.journal.get(name.value);
          if (before)
            return before._tag === "Success"
              ? Effect.succeed(before.value)
              : Effect.fail(new Value.Rejected({ rejection: before.rejection }));
          /** Run the step once, with the ids its commands get from it. */
          const once = (again: boolean) => {
            const scope: Scope = {
              key: `${frame.id}/${name.value}`,
              again,
              step: name.value,
              ordinal: 0,
              refused: false,
            };
            const asked = sequence.calls.length;
            return Effect.suspend(() => {
              stepping = scope;
              return execute.run;
            }).pipe(
              Effect.result,
              Effect.map((result) => {
                stepping = undefined;
                return {
                  result,
                  // Run again, it sends the same commands under the same ids, and each
                  // instance that took one does nothing more. An external system that
                  // answers something else, or a command refused the first time, changes that.
                  differs: sequence.calls.length > asked || scope.refused,
                };
              }),
            );
          };
          return Effect.gen(function* () {
            const first = yield* once(false);
            const stopped =
              Result.isFailure(first.result) &&
              (first.result.failure._tag !== "Rejected" ||
                first.result.failure.rejection === SUSPENDED);
            // The step ran, and the saga stopped before what it gave was kept: it runs again.
            const made =
              options.faults.rerun &&
              !stopped &&
              first.differs &&
              !sequence.reran &&
              interpreter.current.run.choose(2) === 1
                ? yield* Effect.suspend(() => {
                    sequence.reran = true;
                    return once(true);
                  })
                : first;
            const result = made.result;
            if (Result.isSuccess(result)) {
              frame.journal.set(name.value, { _tag: "Success", value: result.success });
              return result.success;
            }
            const error = result.failure;
            if (error._tag === "Rejected" && error.rejection !== SUSPENDED) {
              frame.journal.set(name.value, { _tag: "Failure", rejection: error.rejection });
              if (!declares) {
                frame.flagged.add(error.rejection);
                sequence.failures.push({
                  policy: reacting ?? "a saga",
                  tag: `${tagOf(error.rejection) ?? "an error"} in the activity ${name.value}, which declares no error`,
                });
              }
            }
            return yield* error;
          });
        }),
      );
    });
    interpreter.hooks.models.set("effect/workflow:DurableDeferred.await", ([deferred], site) => {
      const name = signalOf(deferred);
      if (name === undefined)
        return Effect.fail(
          Value.notTranslated(site, "waits for a signal the explorer cannot follow"),
        );
      return Effect.succeed(
        effect(() => {
          const frame = working;
          if (!frame)
            return Effect.fail(Value.notTranslated(site, "waits for a signal outside a saga"));
          const value = frame.signals.get(name);
          if (value) return Effect.succeed(value);
          frame.waiting = name;
          return Effect.fail(new Value.Rejected({ rejection: SUSPENDED }));
        }),
      );
    });
    interpreter.hooks.models.set("effect/workflow:Workflow.addFinalizer", ([finalizer], site) =>
      Effect.succeed(
        effect(() => {
          if (!working || !finalizer)
            return Effect.fail(Value.notTranslated(site, "adds a finalizer outside a saga"));
          working.finalizers.push(finalizer);
          return Effect.succeed(Value.undef);
        }),
      ),
    );
    interpreter.hooks.models.set("effect/Exit:isSuccess", ([exit]) =>
      Effect.succeed(Value.bool(exit !== undefined && tagOf(exit) === "Success")),
    );
    // `Saga.withCompensation(undo)`: when the step it wraps has run and the saga then fails, `undo` runs.
    interpreter.hooks.host = (value, [compensate], site) => {
      // `Account.ref(id)`: the address of an instance, as a view's `keyOf` gives it.
      const addressed = aggs.find(
        (agg) => (agg.cls as unknown as { readonly ref?: unknown }).ref === value,
      );
      if (addressed && compensate)
        return Effect.succeed(Value.obj({ aggregate: Value.str(addressed.name), id: compensate }));
      if (!compensate || !sagas.some((saga) => saga.cls.withCompensation === value))
        return undefined;
      return Effect.succeed(
        native("withCompensation", ([self]) => {
          if (self?._tag !== "Effect")
            return Effect.fail(
              Value.notTranslated(site, "compensates something that is not a step"),
            );
          return Effect.succeed(
            effect(() =>
              self.run.pipe(
                Effect.tap((made) =>
                  Effect.sync(() => {
                    working?.finalizers.push(
                      native("compensation", ([exit], at) => {
                        const cause = exit?._tag === "Obj" ? exit.fields.cause : undefined;
                        return cause
                          ? interpreter.call(compensate, [made, cause], at)
                          : Effect.succeed(Value.undef);
                      }),
                    );
                  }),
                ),
              ),
            ),
          );
        }),
      );
    };

    /** Run a saga from its first line: the activities that ran before give what they gave then. */
    const resume: (index: number) => Eval<void> = Effect.fnUntraced(function* (index: number) {
      const entry = sequence.sagas[index]!;
      const input = entry.input;
      if (input?._tag !== "Obj" || entry.done || entry.waiting !== undefined) return;
      const saga = entry.saga;
      const site: Site = { module: saga.module, node: saga.node };
      const frame: NonNullable<typeof working> = {
        id: `${saga.name}#${index}`,
        journal: new Map(entry.journal),
        signals: entry.signals,
        finalizers: [],
        flagged: new Set(),
        waiting: undefined,
      };
      working = frame;
      reacting = saga.name;
      const exit = yield* interpreter.evaluate(saga.node, interpreter.moduleEnv(saga.module)).pipe(
        Effect.flatMap((layer) => interpreter.settle(layer, site)),
        Effect.flatMap((handler) =>
          interpreter.call(handler, [Value.obj({ key: entry.key, ...input.fields })], site),
        ),
        Effect.flatMap(finish),
        Effect.map((value) => Value.obj({ _tag: Value.str("Success"), value })),
        Effect.catchTag("Rejected", (rejected) =>
          Effect.succeed(
            rejected.rejection === SUSPENDED
              ? SUSPENDED
              : Value.obj({
                  _tag: Value.str("Failure"),
                  cause: Value.obj({
                    reasons: {
                      _tag: "Arr",
                      items: [Value.obj({ _tag: Value.str("Fail"), error: rejected.rejection })],
                    },
                  }),
                }),
          ),
        ),
      );
      sequence.ran.sagas.add(saga.name);
      if (exit === SUSPENDED) {
        sequence.sagas[index] = { ...entry, journal: frame.journal, waiting: frame.waiting };
        sequence.endings.push({
          saga: saga.name,
          ending: `waits for ${frame.waiting}`,
          at: sequence.trail.length,
        });
      } else {
        // What the run registered to do at its end, last registered first.
        for (const finalizer of [...frame.finalizers].reverse()) {
          const escaped = yield* interpreter.call(finalizer, [exit], site).pipe(
            Effect.flatMap(finish),
            Effect.as(undefined),
            Effect.catchTag("Rejected", (rejected) => Effect.succeed(rejected.rejection)),
          );
          if (escaped && !frame.flagged.has(escaped))
            sequence.failures.push({
              policy: saga.name,
              tag: `${tagOf(escaped) ?? "an error"} in a finalizer`,
            });
        }
        const cause = exit._tag === "Obj" ? exit.fields.cause : undefined;
        const reasons = cause?._tag === "Obj" ? cause.fields.reasons : undefined;
        const reason = reasons?._tag === "Arr" ? reasons.items[0] : undefined;
        const rejection = reason?._tag === "Obj" ? reason.fields.error : undefined;
        const tag = rejection ? (tagOf(rejection) ?? "an error") : undefined;
        if (
          rejection &&
          tag !== undefined &&
          !saga.rejects.includes(tag) &&
          !frame.flagged.has(rejection)
        )
          sequence.failures.push({
            policy: saga.name,
            tag: `${tag}, which the saga does not declare`,
          });
        sequence.sagas[index] = { ...entry, journal: frame.journal, done: true };
        sequence.endings.push({
          saga: saga.name,
          ending: tag === undefined ? "completes" : `fails with ${tag}`,
          at: sequence.trail.length,
        });
      }
      working = undefined;
      reacting = undefined;
    });

    /** Run the policies and sagas on what was recorded, until none has anything left to react to. */
    const drain: () => Eval<void> = Effect.fnUntraced(function* () {
      let reactions = 0;
      while (sequence.queue.length > 0) {
        const next = sequence.queue.shift()!;
        if (++reactions > MAX_REACTIONS) {
          sequence.unsettled = true;
          return;
        }
        if ("resume" in next) {
          yield* resume(next.resume);
          continue;
        }
        const trigger = next;
        const policy = trigger.policy;
        // Reactions that wait at the same time run in no set order: this one may go last.
        // One is moved after each command a caller sends, so the orders tried grow with
        // the reactions, not with every way to shuffle them.
        // Only where it can matter: two that write no aggregate in common give the same
        // states in either order.
        const clashes = (other: Trigger | Resume) =>
          "resume" in other
            ? policy.writes === undefined || policy.writes.size > 0
            : !other.again &&
              other.policy !== policy &&
              (policy.writes === undefined ||
                other.policy.writes === undefined ||
                [...policy.writes].some((agg) => other.policy.writes!.has(agg)));
        if (
          options.faults.reorder &&
          !sequence.moved &&
          !trigger.deferred &&
          !trigger.again &&
          sequence.queue.some(clashes) &&
          interpreter.current.run.choose(2) === 1
        ) {
          sequence.moved = true;
          sequence.queue.push({ ...trigger, deferred: true });
          continue;
        }
        const site: Site = { module: policy.module, node: policy.node };
        const parent = sequence.trail[trigger.parent]!;
        const source = trigger.source;
        reacting = policy.name;
        const delivery = {
          key: trigger.key,
          again: trigger.again === true,
          ordinal: 0,
          refused: false,
        };
        delivering = delivery;
        const asked = sequence.calls.length;
        const rejection = yield* interpreter
          .evaluate(policy.node, interpreter.moduleEnv(policy.module))
          .pipe(
            Effect.flatMap((layer) => interpreter.settle(layer, site)),
            Effect.flatMap((handler) =>
              interpreter.call(
                handler,
                [
                  Value.obj({
                    source,
                    key: source,
                    event: trigger.event,
                    state: trigger.state ?? Value.undef,
                    envelope: Value.obj({
                      id: trigger.id,
                      at: parent.inputs.now,
                      commandId: parent.inputs.commandId,
                      correlationId: parent.inputs.commandId,
                    }),
                  }),
                ],
                site,
              ),
            ),
            Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
            Effect.as(undefined),
            Effect.catchTag("Rejected", (rejected) => Effect.succeed(rejected.rejection)),
          );
        reacting = undefined;
        delivering = undefined;
        sequence.ran.policies.add(policy.name);
        // Delivery is at least once: the event comes again, after what else was waiting.
        // A handler sends the same commands again, under the same ids, and every instance
        // that took one does nothing more. Two things can change that: an external system
        // that answers something else, and a command refused the first time.
        if (
          options.faults.redeliver &&
          !trigger.again &&
          (sequence.calls.length > asked || delivery.refused)
        )
          sequence.queue.push({ ...trigger, again: true, deferred: true });
        if (rejection)
          sequence.failures.push({ policy: policy.name, tag: tagOf(rejection) ?? "an error" });
      }
    });

    /** The solver's values as real commands, run one after another on the real code. */
    const replay = Effect.fn(function* (played: Sequence, run: Value.Run, model: Check.Model) {
      const build = (what: string, value: V) => {
        const built = Symbolic.concretize(value, model, run.lists);
        return "value" in built
          ? Effect.succeed(built.value)
          : Effect.fail(new Disagreement({ reason: `${built.reason} (${what})` }));
      };
      const real: Array<{
        agg: Agg;
        id: string;
        state: unknown;
        version: number;
        events: Array<unknown>;
      }> = [];
      for (const instance of played.instances)
        real.push({
          agg: instance.agg,
          id: (yield* build("id", instance.id)) as string,
          state: instance.agg.cls.definition.initial,
          version: 0,
          events: [],
        });
      const story: Array<Step> = [];
      const breaks: Array<{
        readonly name: string;
        readonly at: number;
        readonly rule?: "invariant" | "eventually";
      }> = [];
      /** Each view's real state, by view and key. */
      const seen = new Map<number, Map<string, unknown>>();
      /** What each projection was really given, by projection. */
      const given = new Map<
        number,
        Array<{ readonly id: string; readonly event: unknown; readonly state: unknown }>
      >();
      const asked: Array<Asked & { readonly at: number }> = [];
      // A second delivery that sent nothing new changed nothing: what it asked is left out.
      const resent = played.trail.some((entry) => entry.again);
      for (const call of played.calls) {
        if (call.again && !resent) continue;
        const built = Symbolic.concretize(call.answer, model, run.lists);
        asked.push({
          at: call.at,
          by: call.by,
          call: call.call,
          op: call.op,
          answer: "value" in built ? built.value : "an answer the explorer cannot show",
          failed: call.failed,
          again: call.again,
          step: call.step,
        });
      }
      /** The calls made after a command, by what reacted to it or to one before it. */
      const after = (at: number) =>
        asked.flatMap(({ at: made, ...call }) => (made === at + 1 ? [call] : []));
      for (const [at, entry] of played.trail.entries()) {
        const slot = real[entry.instance];
        const { _tag: tag, ...fields } = (yield* build("command", entry.inputs.command)) as {
          readonly _tag: string;
        };
        const cls = entry.command as unknown as new (fields: object) => { readonly _tag: string };
        const command = yield* Effect.try({
          try: () => new cls(fields),
          catch: (cause) =>
            new Disagreement({
              reason: `${tag} refuses the solver's input ${Symbolic.show(fields)}: ${String(cause)}`,
            }),
        });
        let context = Context.empty() as Context.Context<unknown>;
        const read: Array<{ name: string; value: unknown; tag: unknown }> = [];
        for (const [key, held] of run.contexts) {
          if (!key.startsWith(entry.label)) continue;
          const value = yield* build(key, held.value);
          context = Context.add(context, held.tag as Context.Key<unknown, unknown>, value);
          read.push({ name: key.slice(key.lastIndexOf("/") + 1), value, tag: held.tag });
        }
        const now = (yield* build("now", entry.inputs.now)) as DateTime.Utc;
        const commandId = (yield* build("commandId", entry.inputs.commandId)) as string;
        const decision = entry.decided?.decision;
        const where = decision
          ? `step ${at + 1}, ${Symbolic.show(command)}`
          : `step ${at + 1}, ${Symbolic.show(command)} to ${entry.agg.name} ${Symbolic.show(slot?.id)}`;
        /** What the real code did: one part for each instance it recorded on. */
        let ran:
          | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
          | { readonly _tag: "Unpredictable"; readonly cause: Cause.Cause<unknown> }
          | {
              readonly _tag: "Accepted";
              readonly events: ReadonlyArray<{ readonly _tag: string }>;
              readonly wrote: ReadonlyArray<{
                readonly slot: (typeof real)[number];
                readonly before: unknown;
                readonly events: ReadonlyArray<{ readonly _tag: string }>;
                readonly after: unknown;
              }>;
              /** The decision's own transitions the step breaks. */
              readonly broke: ReadonlyArray<string>;
            };
        if (decision) {
          const made = yield* Effect.try({
            try: () =>
              Decide.run(
                decision.cls,
                command,
                new Map(
                  real.map((one) => [
                    `${one.agg.name}/${one.id}`,
                    { state: one.state, version: one.version },
                  ]),
                ),
                { now, commandId, context: context as Context.Context<never> },
              ),
            catch: (cause) =>
              new Disagreement({ reason: `the real code fails on ${where}: ${String(cause)}` }),
          });
          if (made._tag !== "Accepted") ran = made;
          else {
            const wrote = made.wrote.flatMap((wrote) => {
              const found = real.find(
                (one) => one.agg.cls === wrote.aggregate && one.id === wrote.id,
              );
              return wrote.events.length === 0
                ? []
                : [{ slot: found, before: wrote.before, events: wrote.events, after: wrote.after }];
            });
            if (wrote.some((part) => part.slot === undefined))
              return yield* new Disagreement({
                reason: `the real code records on an instance the explorer did not read at ${where}`,
              });
            const moved: Check.DecisionMoved = {
              ran: made,
              streams: [],
              command,
              context: context as Context.Context<never>,
            };
            ran = {
              _tag: "Accepted",
              events: made.events,
              wrote: wrote as ReadonlyArray<{
                readonly slot: (typeof real)[number];
                readonly before: unknown;
                readonly events: ReadonlyArray<{ readonly _tag: string }>;
                readonly after: unknown;
              }>,
              broke:
                made.events.length === 0
                  ? []
                  : yield* Effect.try({
                      try: () =>
                        decision.own.filter(
                          (name) => !Check.transition(decision.cls, name).holds(moved),
                        ),
                      catch: (cause) =>
                        new Disagreement({
                          reason: `a rule of ${decision.name} fails on the real code at ${where}: ${String(cause)}`,
                        }),
                    }),
            };
          }
        } else {
          const prediction = Aggregate.predict(entry.agg.cls, slot!.state, command, {
            now,
            version: slot!.version,
            commandId,
            context: context as Context.Context<never>,
          });
          ran =
            prediction._tag !== "Accepted"
              ? prediction
              : {
                  _tag: "Accepted",
                  events: prediction.events,
                  wrote: [
                    {
                      slot: slot!,
                      before: slot!.state,
                      events: prediction.events,
                      after: prediction.state,
                    },
                  ],
                  broke: [],
                };
        }
        if (ran._tag === "Unpredictable")
          return yield* new Disagreement({
            reason: `the real code fails on ${where}: ${Cause.pretty(ran.cause)}`,
          });
        const expected =
          entry.applied._tag === "Rejected"
            ? `rejects with ${tagOf(entry.applied.rejection)}`
            : `records [${(entry.applied._tag === "Changed" ? entry.applied.events : []).map(tagOf).join(", ")}]`;
        const actual =
          ran._tag === "Rejected"
            ? `rejects with ${ran.rejection._tag}`
            : `records [${ran.events.map((event) => event._tag).join(", ")}]`;
        if (expected !== actual)
          return yield* new Disagreement({
            reason: `the explorer read that ${where} ${expected}, but the real code ${actual}`,
          });
        const who = {
          aggregate: entry.agg.name,
          id: slot?.id ?? "",
          recorded:
            decision === undefined
              ? undefined
              : ran._tag === "Accepted"
                ? ran.wrote.map((part) => ({
                    aggregate: part.slot.agg.name,
                    id: part.slot.id,
                    events: part.events,
                  }))
                : [],
          by: entry.by,
          after: entry.after,
          asked: after(at),
          again: entry.again,
          step: entry.step,
          late: entry.pending.some((waiting) => {
            const since = model.get(waiting.since);
            return (
              typeof since === "number" && since + waiting.millis <= DateTime.toEpochMillis(now)
            );
          }),
        };
        if (ran._tag === "Rejected") {
          story.push({
            ...who,
            command,
            context: read,
            now,
            outcome: { _tag: "Rejected", rejection: ran.rejection },
          });
          continue;
        }
        story.push({
          ...who,
          command,
          context: read,
          now,
          outcome: { _tag: "Accepted", events: ran.events, state: ran.wrote[0]?.after },
        });
        for (const part of ran.wrote) {
          const moved: Check.Moved = {
            before: part.before,
            after: part.after,
            command,
            events: part.events,
            context: context as Context.Context<never>,
          };
          part.slot.state = part.after;
          part.slot.version += part.events.length;
          part.slot.events.push(...part.events);
          for (const [name, holds] of Object.entries(part.slot.agg.rules))
            if (holds(moved) !== true) breaks.push({ name: `${part.slot.agg.name}.${name}`, at });
        }
        for (const name of ran.broke) breaks.push({ name: `${decision!.name}.${name}`, at });
        /** The version of the instance whose events the views are being fed. */
        let seq = 0;
        // The real views on the real events: they emit what the explorer read, or it is wrong.
        const emitted = new Map<ViewImpl, Array<string>>();
        const feed = (
          view: ViewImpl,
          index: number,
          origin: unknown,
          source: unknown,
          state: unknown,
          event: { readonly _tag: string },
        ): void => {
          const from = view.sources.get(origin);
          if (from === undefined) return;
          const def = view.cls.definition;
          if (
            view.kind === "projection"
              ? !view.on.some((cls) => (cls as { readonly tag?: unknown }).tag === event._tag)
              : !(
                  def.evolve?.[event._tag] ||
                  def.evolve?.[from] ||
                  def.emit?.[event._tag] ||
                  def.emit?.[from] ||
                  view.declared?.has(event._tag)
                )
          )
            return;
          const tags = emitted.get(view) ?? [];
          emitted.set(view, tags);
          const envelope = {
            id: Aggregate.targetId(source),
            stream: `${from}/${Aggregate.targetId(source)}`,
            seq,
            at: now,
            commandId,
            correlationId: commandId,
          };
          const routing = { event, source, state, envelope };
          const keyOf = def.keyOf as Readonly<Record<string, unknown>> | undefined;
          const custom = keyOf?.[event._tag] ?? keyOf?.[from];
          const routes: ReadonlyArray<{
            readonly route: string | undefined;
            readonly key: unknown;
          }> =
            typeof custom === "function"
              ? [{ route: undefined, key: (custom as RealHandler)(routing) }]
              : custom
                ? Object.entries(custom as Readonly<Record<string, RealHandler | undefined>>).map(
                    ([route, pick]) => ({ route, key: pick?.(routing) }),
                  )
                : [{ route: undefined, key: source }];
          const pick = (map: Readonly<Record<string, unknown>> | undefined, route?: string) => {
            const handler = map?.[event._tag] ?? map?.[from];
            const found =
              typeof handler === "function"
                ? handler
                : route !== undefined
                  ? (handler as Readonly<Record<string, unknown>> | undefined)?.[route]
                  : undefined;
            return typeof found === "function" ? (found as RealHandler) : undefined;
          };
          for (const { route, key } of routes) {
            if (key === undefined) continue;
            const id = Aggregate.targetId(key);
            const ref = Key.refOf(def.key as Key.Any, id);
            if (view.kind === "projection") {
              const rows = given.get(index) ?? [];
              given.set(index, rows);
              rows.push({ id, event, state });
              tags.push(event._tag);
              continue;
            }
            const states = seen.get(index) ?? new Map<string, unknown>();
            seen.set(index, states);
            const context = { key: ref, source, state, envelope, at: now };
            const before = view.stateful ? (states.get(id) ?? def.initial) : null;
            const evolve = view.stateful ? pick(def.evolve, route) : undefined;
            if (evolve) states.set(id, evolve(before, event, context) ?? null);
            const after = states.get(id) ?? null;
            const emit = pick(def.emit, route);
            const out = (
              !view.declared
                ? evolve
                  ? [event]
                  : []
                : emit
                  ? [emit(event, { ...context, before, after })].flat()
                  : view.declared.has(event._tag)
                    ? [event]
                    : []
            ) as ReadonlyArray<{ readonly _tag: string } | undefined>;
            for (const one of out) {
              if (one === undefined) continue;
              tags.push(one._tag);
              for (const [next, reader] of located.views.entries())
                feed(reader, next, view.cls, ref, after, one);
            }
          }
        };
        for (const part of ran.wrote) {
          const ref = Aggregate.makeRef(part.slot.agg.cls, part.slot.id as never);
          seq = part.slot.version;
          for (const event of part.events)
            for (const [index, view] of located.views.entries())
              yield* Effect.try({
                try: () => feed(view, index, part.slot.agg.cls, ref, undefined, event),
                catch: (cause) =>
                  new Disagreement({
                    reason: `${view.name} fails on the real code at ${where}: ${String(cause)}`,
                  }),
              });
        }
        for (const view of located.views) {
          const read = entry.emitted.flatMap((made) => (made.view === view ? made.tags : []));
          const tags = emitted.get(view) ?? [];
          if (read.join(", ") !== tags.join(", "))
            return yield* new Disagreement({
              reason: `the explorer read that ${view.name} ${view.kind === "view" ? "emits" : "is given"} [${read.join(", ")}] after ${where}, but the real one ${view.kind === "view" ? "emits" : "is given"} [${tags.join(", ")}]`,
            });
        }
      }
      if (played.rules.length > 0 || played.later.length > 0) {
        // The same sequence on the real code, and the model's real invariants on what it left.
        const model = {
          ...Object.fromEntries(
            located.views.map((view, index) => [
              view.name,
              view.kind === "projection"
                ? (given.get(index) ?? [])
                : [...(seen.get(index) ?? [])].flatMap(([id, state]) =>
                    state === null ? [] : [{ id, state }],
                  ),
            ]),
          ),
          ...Object.fromEntries(
            aggs.map((agg) => [
              agg.name,
              real.flatMap((slot) =>
                slot.agg === agg ? [{ id: slot.id, state: slot.state, events: slot.events }] : [],
              ),
            ]),
          ),
        };
        for (const [rule, names, real] of [
          ["invariant", played.rules.length > 0 ? located.rules.names : [], located.rules.real],
          [
            "eventually",
            played.later.length > 0 ? located.rules.later : [],
            located.rules.realLater,
          ],
        ] as const)
          for (const name of names) {
            const holds = yield* Effect.try({
              try: () => real[name]?.(model),
              catch: (cause) =>
                new Disagreement({
                  reason: `the model's rule ${name} fails on the real code: ${String(cause)}`,
                }),
            });
            if (holds === false) breaks.push({ name, at: played.trail.length - 1, rule });
          }
      }
      return { story, breaks };
    });

    /**
     * Values that make `condition` false. A story reads best when no time
     * passes between its commands and no name in it is empty, so those are
     * asked for first, where the sequence allows them.
     */
    const values = Effect.fn(function* (played: Sequence, run: Value.Run, condition: string) {
      const answer = yield* Check.solve(solver, run, condition);
      if (answer._tag !== "Sat") return answer;
      // A scheduled command is the one step that needs time to pass.
      const still = played.trail
        .slice(1)
        .flatMap((entry, index) =>
          entry.after === undefined
            ? [
                `(= ${Smt.symbol(`${entry.label}now`)} ${Smt.symbol(`${played.trail[index]!.label}now`)})`,
              ]
            : [],
        );
      const named = [...run.declarations].flatMap(([name, declaration]) =>
        declaration.startsWith("(declare-const ") && declaration.endsWith(" String)")
          ? [`(> (str.len ${name}) 0)`]
          : [],
      );
      // And a scheduled command runs when it is due, before anything sent after: a
      // story's clock runs every one that is due at once.
      const prompt = played.trail.flatMap((entry) =>
        entry.pending.map(
          (waiting) =>
            `(< ${Smt.symbol(`${entry.label}now`)} (+ ${waiting.since} ${waiting.millis}))`,
        ),
      );
      for (const wishes of prompt.length > 0
        ? [[...still, ...named, ...prompt], [...still, ...prompt], still]
        : [[...still, ...named], still]) {
        if (wishes.length === 0) continue;
        const again = yield* Check.solve(
          solver,
          run,
          `(or ${condition} (not (and ${wishes.join(" ")})))`,
        );
        if (again._tag === "Sat") return again;
      }
      return answer;
    });

    const attempt = (played: Sequence, run: Value.Run, model: Check.Model) =>
      replay(played, run, model).pipe(
        Effect.catchTag("Disagreement", (error) =>
          Effect.sync(() => {
            disagreements.add(error.reason);
            return undefined;
          }),
        ),
      );

    /**
     * Look at a sequence after its last command and the reactions to it. Says
     * whether it can happen at all: when it cannot, nothing longer is run.
     */
    const visit = Effect.fn(function* (
      run: Value.Run,
      played: Sequence,
      from: number,
      canGoOn: boolean,
    ) {
      const wants: Array<(story: Story) => void> = [];
      for (const [at, entry] of played.trail.entries()) {
        if (at < from) continue;
        const length = at + 1;
        const applied = entry.applied;
        const want = (kind: Outcome["kind"], tag: string | undefined) => {
          if (tag === undefined) return;
          const owner = entry.decided ? undefined : entry.agg.name;
          const name = `${owner === undefined ? "" : `${owner}.`}${entry.command.tag} ${kind} ${tag}`;
          if (!outcomes.has(name))
            outcomes.set(name, {
              aggregate: owner,
              command: entry.command.tag,
              kind,
              tag,
              story: undefined,
            });
          const outcome = outcomes.get(name)!;
          if (shorter(outcome.story, length))
            wants.push((story) => {
              if (shorter(outcome.story, length)) outcome.story = cut(story, length);
            });
        };
        if (applied._tag === "Rejected") want("rejects", tagOf(applied.rejection));
        if (applied._tag === "Changed") {
          for (const event of applied.events) want("records", tagOf(event));
          for (const part of entry.decided?.parts ?? [{ agg: entry.agg, state: applied.state }]) {
            const state = reached.get(`${part.agg.name} ${tagOf(part.state)}`);
            if (state && shorter(state.story, length))
              wants.push((story) => {
                if (shorter(state.story, length)) state.story = cut(story, length);
              });
          }
        }
      }
      for (const ended of played.endings) {
        const name = `${ended.saga} ${ended.ending}`;
        if (shorter(endings.get(name)?.story, ended.at))
          wants.push((story) => {
            if (shorter(endings.get(name)?.story, ended.at))
              endings.set(name, {
                saga: ended.saga,
                ending: ended.ending,
                story: cut(story, ended.at),
              });
          });
      }
      for (const failure of played.failures) {
        const name = `${failure.policy} fails with ${failure.tag}`;
        if (shorter(failures.get(name)?.story, played.trail.length))
          wants.push((story) => failures.set(name, { ...failure, story }));
      }

      let feasible = true;
      if (canGoOn || wants.length > 0) {
        const answer = yield* wants.length > 0
          ? values(played, run, "false")
          : Check.solve(solver, run, "false");
        if (answer._tag === "Unsat") feasible = false;
        if (answer._tag === "Unknown") gaveUp(answer.reason);
        if (answer._tag === "Sat" && wants.length > 0) {
          const replayed = yield* attempt(played, run, answer.model);
          if (replayed) for (const want of wants) want(replayed.story);
        }
      }
      if (!feasible) return false;
      if (played.unsettled) unsettled++;

      const open: Array<string> = [];
      for (const [at, entry] of played.trail.entries()) {
        if (at < from || entry.applied._tag !== "Changed") continue;
        states++;
        // Each rule a step has to keep, under the name the report gives it, and what proves it.
        const checked = entry.decided
          ? [
              ...entry.decided.parts.flatMap((part) =>
                part.checks.map((check) => ({
                  check,
                  name: `${part.agg.name}.${check.name}`,
                  by: `${part.agg.name}.${entry.command.tag}`,
                })),
              ),
              ...entry.decided.own.map((check) => ({
                check,
                name: `${entry.command.tag}.${check.name}`,
                by: entry.command.tag,
              })),
            ]
          : entry.checks.map((check) => ({
              check,
              name: `${entry.agg.name}.${check.name}`,
              by: `${entry.agg.name}.${entry.command.tag}`,
            }));
        for (const { check, name, by } of checked) {
          if (Result.isFailure(check.condition)) {
            const error = check.condition.failure;
            unread.set(`${error.file}:${error.line}`, error);
            continue;
          }
          look(name);
          if (
            check.condition.success !== "true" &&
            !kept.get(by)?.has(check.name) &&
            shorter(broken.get(name)?.story, at + 1)
          ) {
            open.push(check.condition.success);
          }
        }
      }
      for (const check of played.rules) {
        if (Result.isFailure(check.condition)) {
          const error = check.condition.failure;
          unread.set(`${error.file}:${error.line}`, error);
          continue;
        }
        look(` ${check.name}`);
        if (
          check.condition.success !== "true" &&
          shorter(ruled.get(check.name), played.trail.length)
        ) {
          open.push(check.condition.success);
        }
      }
      for (const check of played.later) {
        if (Result.isFailure(check.condition)) {
          const error = check.condition.failure;
          unread.set(`${error.file}:${error.line}`, error);
          continue;
        }
        look(`~${check.name}`);
        if (
          check.condition.success !== "true" &&
          shorter(ended.get(check.name), played.trail.length)
        ) {
          open.push(check.condition.success);
        }
      }
      if (open.length > 0) {
        const answer = yield* values(
          played,
          run,
          open.length === 1 ? open[0]! : `(and ${open.join(" ")})`,
        );
        if (answer._tag === "Unknown") gaveUp(answer.reason);
        if (answer._tag === "Sat") {
          const replayed = yield* attempt(played, run, answer.model);
          if (replayed && replayed.breaks.length === 0)
            disagreements.add(
              "the solver found a sequence that breaks an invariant, but the real code keeps every invariant on it",
            );
          for (const found of replayed?.breaks ?? []) {
            if (found.rule) {
              const kept = found.rule === "invariant" ? ruled : ended;
              if (shorter(kept.get(found.name), found.at + 1))
                kept.set(found.name, cut(replayed!.story, found.at + 1));
              continue;
            }
            const entry = broken.get(found.name);
            if (entry && shorter(entry.story, found.at + 1))
              entry.story = cut(replayed!.story, found.at + 1);
          }
        }
      }
      return true;
    });

    /** Every instance in a sequence, by aggregate, with its state and the events it recorded. */
    const world = (played: Sequence): V =>
      Value.obj({
        ...Object.fromEntries(
          located.views.map((view) => [
            view.name,
            {
              _tag: "Arr",
              items:
                view.kind === "projection"
                  ? played.fed.flatMap((fed) =>
                      fed.view === view
                        ? [Value.obj({ id: fed.key, event: fed.event, state: fed.state })]
                        : [],
                    )
                  : played.views.flatMap((slot) =>
                      slot.view === view && slot.state
                        ? [Value.obj({ id: slot.key, state: slot.state })]
                        : [],
                    ),
            } satisfies V,
          ]),
        ),
        ...Object.fromEntries(
          aggs.map((agg) => [
            agg.name,
            {
              _tag: "Arr",
              items: played.instances.flatMap((instance, index) =>
                instance.agg === agg
                  ? [
                      Value.obj({
                        id: instance.id,
                        state: instance.state,
                        events: {
                          _tag: "Arr",
                          items: played.trail.flatMap((entry) =>
                            entry.decided
                              ? entry.decided.parts.flatMap((part) =>
                                  part.instance === index ? part.events : [],
                                )
                              : entry.instance === index && entry.applied._tag === "Changed"
                                ? entry.applied.events
                                : [],
                          ),
                        },
                      }),
                    ]
                  : [],
              ),
            } satisfies V,
          ]),
        ),
      });

    /** Every way one move can go from a sequence, with the reactions to it. */
    const play: (
      from: Open,
      longer: Array<Open>,
      move: (run: Value.Run) => Eval<unknown>,
      ending?: boolean,
      pick?: (of: number) => number,
    ) => Effect.Effect<void, PolicyUnread | Smt.SolverError> = Effect.fn(function* (
      from: Open,
      longer: Array<Open>,
      move: (run: Value.Run) => Eval<unknown>,
      /**
       * Running a sequence to its end, past the most commands a caller sends:
       * only the schedules left in it come due.
       */
      ending = false,
      /**
       * Walking: one way the move can go, picked at each choice, and no limit
       * on how many commands came before.
       */
      pick?: (of: number) => number,
    ) {
      let prefix: ReadonlyArray<number> | undefined = [];
      while (prefix) {
        if (!pick && sequences >= options.budget) {
          truncated = true;
          return;
        }
        const run = from.run.fork(prefix, pick);
        interpreter.current.run = run;
        interpreter.hooks.provided.clear();
        sequence = begin(from);
        reacting = undefined;
        delivering = undefined;
        working = undefined;
        stopped = undefined;
        const ran = yield* Effect.suspend(() => move(run)).pipe(
          Effect.flatMap(() => drain()),
          Effect.result,
        );
        if (Result.isFailure(ran)) {
          prefix = Value.nextPrefix(run.taken);
          const error = ran.failure;
          if (error._tag === "NotTranslated") {
            // Code of a policy's or saga's own, not of a command it sent: leave it out.
            if (reacting !== undefined && stopped !== error)
              return yield* new PolicyUnread({ policy: reacting, error });
            unread.set(`${error.file}:${error.line}`, error);
          }
          sequences++;
          continue;
        }
        const played = sequence;
        const changed = played.trail
          .slice(from.trail.length)
          .some((entry) => entry.applied._tag === "Changed");
        // Nothing is left to react: this is where the model's invariants are looked at.
        const rules =
          changed && !played.unsettled && located.rules.definition
            ? yield* Effect.gen(function* () {
                const made = [
                  ...(yield* Paths.checks(interpreter, located.rules.definition!, world(played))),
                ];
                // A relation that is not proved, on every choice of the instances there are.
                for (const relation of located.rules.relations) {
                  if (provedRelations.has(relation.name)) continue;
                  const names = Object.keys(relation.over);
                  /** Every choice of instances for its names, no two the same. */
                  const choices: Array<ReadonlyArray<Instance>> = [];
                  const choose = (at: number, chosen: ReadonlyArray<Instance>): void => {
                    if (at === names.length) return void choices.push(chosen);
                    for (const instance of played.instances)
                      if (instance.agg === relation.aggs[at] && !chosen.includes(instance))
                        choose(at + 1, [...chosen, instance]);
                  };
                  choose(0, []);
                  const formulas: Array<string> = [];
                  let condition: Value.NotTranslated | undefined;
                  for (const chosen of choices) {
                    const formula = yield* Paths.relationHolds(
                      interpreter,
                      located.rules.definition!,
                      relation.name,
                      Object.fromEntries(names.map((key, index) => [key, chosen[index]!])),
                    ).pipe(Effect.catchTag("NotTranslated", (error) => Effect.succeed(error)));
                    if (typeof formula === "string") formulas.push(formula);
                    else condition = formula;
                  }
                  made.push({
                    name: relation.name,
                    condition: condition
                      ? Result.fail(condition)
                      : Result.succeed(
                          formulas.length === 0
                            ? "true"
                            : formulas.length === 1
                              ? formulas[0]!
                              : `(and ${formulas.join(" ")})`,
                        ),
                  });
                }
                return made;
              }).pipe(Effect.result)
            : Result.succeed([]);
        // Nothing is scheduled either: the sequence has run its course.
        const later =
          !played.unsettled &&
          played.timers.length === 0 &&
          (changed || ending) &&
          located.rules.definition &&
          located.rules.later.length > 0
            ? yield* Paths.checks(
                interpreter,
                located.rules.definition,
                world(played),
                undefined,
                undefined,
                "eventually",
              ).pipe(Effect.result)
            : Result.succeed([]);
        prefix = Value.nextPrefix(run.taken);
        if (Result.isFailure(rules) || Result.isFailure(later)) {
          sequences++;
          continue;
        }
        played.rules = rules.success;
        played.later = later.success;
        // A walk takes one way through its move, then goes on from wherever that left it.
        if (pick) prefix = undefined;
        const canGoOn = ending
          ? !played.unsettled && played.timers.length > 0
          : changed && !played.unsettled && (pick !== undefined || from.length + 1 < options.depth);
        moving = from.length + 1;
        const feasible = yield* visit(run, played, from.trail.length, canGoOn);
        const fresh =
          [...played.ran.policies].some((name) => !followed.has(name)) ||
          [...played.ran.sagas].some((name) => !started.has(name)) ||
          [...played.ran.systems].some((name) => !called.has(name)) ||
          [...played.ran.repeated].some((name) => !repeated.has(name));
        // Something ran here for the first time: it counts when the sequence can happen.
        if (feasible && fresh && (yield* Check.solve(solver, run, "false"))._tag === "Sat") {
          for (const name of played.ran.policies) followed.add(name);
          for (const name of played.ran.sagas) started.add(name);
          for (const name of played.ran.systems) called.add(name);
          for (const name of played.ran.repeated) repeated.add(name);
        }
        const next: Open = {
          run,
          trail: played.trail,
          instances: played.instances,
          views: played.views,
          fed: played.fed,
          calls: played.calls,
          receipts: played.receipts,
          armed: played.armed,
          decisions: played.decisions,
          sagas: played.sagas,
          timers: played.timers,
          length: from.length + 1,
        };
        if (feasible && canGoOn) longer.push(next);
        else sequences++;
        // What is still scheduled comes due, one after another, and the end is looked at.
        if (
          feasible &&
          !ending &&
          !pick &&
          !played.unsettled &&
          changed &&
          played.timers.length > 0 &&
          located.rules.later.length > 0
        ) {
          const before = moving;
          let left: Array<Open> = [next];
          let rounds = 0;
          while (left.length > 0 && !truncated) {
            // A schedule that keeps scheduling never runs its course.
            if (++rounds > MAX_SCHEDULES) {
              unsettled += left.length;
              break;
            }
            const further: Array<Open> = [];
            for (const one of left) {
              const timer = one.timers[0]!;
              yield* play(
                one,
                further,
                () => {
                  sequence.timers = sequence.timers.slice(1);
                  const index = resolve(timer.agg, timer.address, textOf(timer.address)!);
                  return apply(timer.agg, index, timer.cls, timer.command, timer);
                },
                true,
              );
              if (truncated) break;
            }
            left = further;
          }
          moving = before;
        }
      }
    });

    /** Each move that can follow a sequence: a caller's command, or a schedule that comes due. */
    const moves = (from: Open): ReadonlyArray<(run: Value.Run) => Eval<unknown>> => [
      ...externals.flatMap(({ agg, command }) => {
        const existing = from.instances.flatMap((instance, index) =>
          instance.agg === agg ? [index] : [],
        );
        const targets: ReadonlyArray<number | undefined> = [
          ...existing,
          ...(existing.length < options.instances ? [undefined] : []),
        ];
        return targets.map((target) => (run: Value.Run) => {
          let index = target;
          if (index === undefined) {
            // An instance nobody has addressed yet.
            const id = run.constant(`${agg.name}#${existing.length + 1}.id`, "String");
            const ast = Symbolic.typeOf(agg.cls.definition.id);
            const value: V = { _tag: "Term", term: id };
            if (ast) Symbolic.assumeFits(value, ast, run);
            for (const at of existing)
              run.assume(`(not (= ${id.text} ${textOf(from.instances[at]!.id)}))`);
            sequence.instances.push({ agg, id: value, state: agg.initial, version: 0 });
            index = sequence.instances.length - 1;
          }
          return apply(agg, index, command, undefined);
        });
      }),
      ...decided.map((decision) => () => applyDecision(decision, undefined, true)),
      ...from.timers.map((timer, at) => () => {
        sequence.timers = sequence.timers.filter((_, index) => index !== at);
        const index = resolve(timer.agg, timer.address, textOf(timer.address)!);
        return apply(timer.agg, index, timer.cls, timer.command, timer);
      }),
    ];

    /** Every sequence one move longer than this one. */
    const extend = Effect.fn(function* (from: Open, longer: Array<Open>) {
      for (const move of moves(from)) {
        yield* play(from, longer, move);
        if (truncated) return;
      }
    });

    let open: Array<Open> = [nothing];
    let complete = 0;
    while (open.length > 0 && !truncated) {
      const longer: Array<Open> = [];
      for (const from of open) {
        yield* extend(from, longer);
        if (truncated) break;
      }
      if (!truncated) complete++;
      open = longer;
    }

    // Past the sequences every one of which was run: walks, each a command picked at
    // random after another, as far as `length`. A rule that takes many commands to
    // break is out of reach of the search above, and within reach of these.
    const random = mulberry(options.walks.seed);
    const pick = (of: number) => Math.floor(random() * of);
    const walks = {
      seed: options.walks.seed,
      count: 0,
      commands: 0,
      longest: 0,
      stories: [] as Array<Story>,
    };
    for (let walk = 0; walk < options.walks.count && !truncated; walk++) {
      let at = nothing;
      let sent = 0;
      // A move that cannot happen, or that changes nothing, is not a step: another is tried.
      for (
        let tries = 0;
        sent < options.walks.length && tries < options.walks.length * 4;
        tries++
      ) {
        const possible = moves(at);
        if (possible.length === 0) break;
        const longer: Array<Open> = [];
        yield* play(at, longer, possible[pick(possible.length)]!, false, pick);
        if (longer.length === 0) continue;
        at = longer[0]!;
        sent++;
      }
      // The walk with values for everything it left open, as the real code runs it.
      if (sent > 0) {
        const played = begin(at);
        const answer = yield* values(played, at.run, "false");
        const replayed =
          answer._tag === "Sat" ? yield* attempt(played, at.run, answer.model) : undefined;
        if (replayed) walks.stories.push(replayed.story);
      }
      walks.count++;
      walks.commands += sent;
      walks.longest = Math.max(walks.longest, sent);
    }

    const found: Found = {
      sequences,
      states,
      truncated,
      complete,
      invariants: [...broken.values()].map((entry) => ({
        aggregate: entry.aggregate,
        name: entry.name,
        kind:
          aggs.find((agg) => agg.name === entry.aggregate)?.transitions.has(entry.name) === false
            ? ("invariant" as const)
            : ("transition" as const),
        broken: entry.story,
        proved: !entry.story && byClass.size > 0 && provedBy(entry.aggregate, entry.name),
        states: looked.get(`${entry.aggregate}.${entry.name}`) ?? 0,
      })),
      dead,
      decisions: decisions.map((decision) => decision.name),
      rules: [...ruled].map(([name, story]) => {
        const row = relationRows.find((row) => row.name === name);
        const isRelation = located.rules.relations.some((relation) => relation.name === name);
        return {
          name,
          kind: isRelation ? ("relation" as const) : ("invariant" as const),
          broken: story,
          proved: !story && provedRelations.has(name),
          unproved:
            row && !provedRelations.has(name)
              ? {
                  by: row.by ?? "a rule it starts from",
                  verdict:
                    row.verdict._tag === "Proved"
                      ? ({
                          _tag: "Unknown",
                          reason: "an invariant of an aggregate it reads is not proved",
                        } as const)
                      : row.verdict,
                }
              : undefined,
          states: looked.get(` ${name}`) ?? 0,
        };
      }),
      eventually: [...ended].map(([name, story]) => ({
        name,
        broken: story,
        states: looked.get(`~${name}`) ?? 0,
      })),
      outcomes: [...outcomes.values()],
      reached: [...reached.values()],
      followed: [...followed],
      idle: policies.flatMap((policy) => (followed.has(policy.name) ? [] : [policy.name])),
      views: located.views.flatMap((view) => (view.kind === "view" ? [view.name] : [])),
      projections: located.views.flatMap((view) => (view.kind === "projection" ? [view.name] : [])),
      systems: [...called],
      faults: options.faults,
      walks,
      repeated: [...repeated],
      sagas: [...started],
      unstarted: sagas.flatMap((saga) => (started.has(saga.name) ? [] : [saga.name])),
      endings: [...endings.values()],
      skipped: [...located.skipped, ...skipped.values()],
      aside: located.aside,
      unkept,
      failures: [...failures.values()],
      unsettled,
      unread: [...unread.values()],
      disagreements: [...disagreements],
      undecided: [...undecided].map(([reason, times]) => ({ reason, times })),
    };
    return found;
  });

  // A policy or saga the explorer cannot read is left out, and the search starts over:
  // what it would have sent is then missing from every sequence, and the report says so.
  const skipped = new Map<string, Skipped>();
  while (true) {
    const found = yield* pass(skipped).pipe(
      Effect.catchTag("PolicyUnread", (unread) =>
        Effect.sync(() => {
          skipped.set(unread.policy, {
            policy: unread.policy,
            reason: unread.error.reason,
            file: unread.error.file,
            line: unread.error.line,
          });
          return undefined;
        }),
      ),
    );
    if (found) return found;
  }
});
