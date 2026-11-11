import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import * as Check from "../../Prove/internal/Check.ts";
import * as Induction from "../../Prove/internal/Induction.ts";
import type { Interpreter } from "../../Prove/internal/Interpreter.ts";
import * as Paths from "../../Prove/internal/Paths.ts";
import * as Smt from "../../Prove/internal/Smt.ts";
import type * as Source from "../../Prove/internal/Source.ts";
import * as Symbolic from "../../Prove/internal/Symbolic.ts";
import type { Eval, Module, Node, Site, V } from "../../Prove/internal/Value.ts";
import * as Value from "../../Prove/internal/Value.ts";
import type { Move } from "./Search.ts";
import { lift, stateTags, tagOf } from "./Search.ts";

/** One command of a story: who it went to, and who sent it. */
export interface Step extends Move {
  readonly aggregate: string;
  readonly id: string;
  /** The policy or saga that sent the command; `undefined` when a caller did, or a schedule. */
  readonly by: string | undefined;
  /** The delay of the schedule that sent the command, as the code wrote it. */
  readonly after: string | undefined;
}

/** Commands callers send one after another, each followed by what the policies do about it. */
export type Story = ReadonlyArray<Step>;

export interface Outcome {
  readonly aggregate: string;
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
    readonly broken: Story | undefined;
    readonly proved: boolean;
  }>;
  /**
   * The model's own invariants, looked at whenever a sequence has nothing left
   * to react: `broken` is the shortest sequence found that breaks one.
   */
  readonly rules: ReadonlyArray<{ readonly name: string; readonly broken: Story | undefined }>;
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
  /** The sagas that ran. */
  readonly sagas: ReadonlyArray<string>;
  /** The sagas no sequence started. */
  readonly unstarted: ReadonlyArray<string>;
  readonly endings: ReadonlyArray<Ending>;
  /** The policies and sagas left out: the sequences were run as if they did nothing. */
  readonly skipped: ReadonlyArray<Skipped>;
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
}

/** A model, as far as the explorer reads it. */
export interface ModelLike {
  readonly modelName: string;
  readonly definitions: {
    readonly aggregates: ReadonlyArray<Aggregate.Any>;
    readonly policies: ReadonlyArray<unknown>;
  };
  readonly sagas?: ReadonlyArray<unknown>;
  readonly invariants?: { readonly [name: string]: (model: never) => boolean };
}

interface PolicyClass {
  readonly policyName: string;
  readonly definition: { readonly from: unknown; readonly on: unknown };
}

interface CommandClass extends Paths.CommandClass {
  readonly events: ReadonlyArray<{ readonly tag: string }>;
  readonly rejects: ReadonlyArray<{ readonly tag: string }>;
}

interface Agg {
  readonly cls: Aggregate.Any;
  readonly name: string;
  readonly definition: Paths.Definition;
  readonly commands: ReadonlyArray<CommandClass>;
  readonly initial: V;
  readonly invariants: ReadonlyArray<string>;
  readonly real: Readonly<Record<string, (state: unknown) => boolean>>;
}

interface PolicyImpl {
  readonly name: string;
  readonly from: unknown;
  readonly on: ReadonlyArray<unknown>;
  readonly module: Module;
  /** The handler's construction: the argument of `toLayer`. */
  readonly node: Node;
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

interface Entry {
  readonly agg: Agg;
  readonly instance: number;
  readonly command: CommandClass;
  readonly label: string;
  readonly inputs: Paths.Inputs;
  readonly applied: Paths.Applied;
  readonly checks: ReadonlyArray<Paths.Check>;
  readonly by: string | undefined;
  readonly after: string | undefined;
}

/** A saga's run to go on with: one just started, or one whose signal came. */
interface Resume {
  readonly resume: number;
}

interface Trigger {
  readonly policy: PolicyImpl;
  readonly instance: number;
  readonly event: V;
  readonly parent: number;
}

/** One sequence while it runs. */
interface Sequence {
  readonly trail: Array<Entry>;
  readonly instances: Array<Instance>;
  readonly queue: Array<Trigger | Resume>;
  readonly sagas: Array<SagaRun>;
  timers: Array<Timer>;
  readonly failures: Array<{ readonly policy: string; readonly tag: string }>;
  /** How each run that stopped did, and how many commands had run by then. */
  readonly endings: Array<{ readonly saga: string; readonly ending: string; readonly at: number }>;
  unsettled: boolean;
  /** The model's invariants on what the sequence left, once nothing more reacts. */
  rules: ReadonlyArray<Paths.Check>;
}

/** The real code does something else than the explorer read. */
class Disagreement extends Data.TaggedError("Disagreement")<{ readonly reason: string }> {}

/** A policy's handler has code the explorer cannot read: the search starts over without it. */
class PolicyUnread extends Data.TaggedError("PolicyUnread")<{
  readonly policy: string;
  readonly error: Value.NotTranslated;
}> {}

/** What a saga's run stops with when it waits for a signal that has not come. */
const SUSPENDED: V = { _tag: "Opaque", what: "a saga waiting for a signal" };

/** The most reactions followed after one command a caller sends. */
const MAX_REACTIONS = 32;

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
  for (const cls of model.definitions.aggregates) {
    const module = modules.find(
      (m) =>
        Object.values(m.exports).includes(cls) &&
        Paths.find(m.program, cls.aggregateName) !== undefined,
    );
    if (!module) {
      missing.push(cls.aggregateName);
      continue;
    }
    const definition: Paths.Definition = {
      module,
      node: Paths.find(module.program, cls.aggregateName)!,
      name: cls.aggregateName,
      state: cls.definition.state,
    };
    aggregates.push({
      cls,
      name: cls.aggregateName,
      definition,
      commands: cls.definition.commands as unknown as ReadonlyArray<CommandClass>,
      initial: lift(cls.definition.initial),
      invariants: Paths.invariantNames(definition),
      real: (cls.definition.invariants ?? {}) as unknown as Record<
        string,
        (state: unknown) => boolean
      >,
    });
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

  const policies: Array<PolicyImpl> = [];
  const skipped: Array<Skipped> = [];
  for (const cls of model.definitions.policies as ReadonlyArray<PolicyClass>) {
    const leave = (reason: string) =>
      skipped.push({ policy: cls.policyName, reason, file: undefined, line: undefined });
    const handler = handlers.get(cls);
    if (!aggregates.some((agg) => agg.cls === cls.definition.from))
      leave("reacts to a view, which the explorer does not follow yet");
    else if (!Array.isArray(cls.definition.on)) leave("its events are not a list");
    else if (!handler) leave("its toLayer is not in a file the model's file imports");
    else
      policies.push({
        name: cls.policyName,
        from: cls.definition.from,
        on: cls.definition.on,
        module: handler.module,
        node: handler.node,
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
  // The model's own invariants, where its file declares them.
  const home = modules.find(
    (m) =>
      Paths.find(m.program, model.modelName) !== undefined &&
      Object.values(m.exports).includes(model),
  );
  const declared: Paths.Definition | undefined = home && {
    module: home,
    node: Paths.find(home.program, model.modelName)!,
    name: model.modelName,
    state: undefined,
  };
  const rules = {
    definition: declared,
    names: declared ? Paths.invariantNames(declared) : [],
    real: (model.invariants ?? {}) as unknown as Record<string, (model: unknown) => boolean>,
  };
  return { aggregates, missing, policies, sagas, skipped, rules };
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

  /**
   * The invariants each command keeps whatever state it meets. A policy's
   * command is one of them, so the proofs cover what policies send too.
   */
  const kept = new Map<string, ReadonlySet<string>>();
  for (const agg of aggs) {
    if (agg.invariants.length === 0) continue;
    const rows = yield* Induction.rows(solver, interpreter, agg.cls, agg.definition);
    if (!Schema.is(agg.definition.state as Schema.Schema<unknown>)(agg.cls.definition.initial))
      continue;
    if (!rows.every((row) => row.fits)) continue;
    for (const row of rows)
      kept.set(
        `${agg.name}.${row.command}`,
        new Set(
          [...row.verdicts].flatMap(([name, verdict]) => (verdict._tag === "Proved" ? [name] : [])),
        ),
      );
  }

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
    const ruled = new Map<string, Story | undefined>(
      located.rules.names.map((name) => [name, undefined]),
    );
    const failures = new Map<string, { policy: string; tag: string; story: Story }>();
    const endings = new Map<string, { saga: string; ending: string; story: Story | undefined }>();
    for (const saga of sagas)
      for (const ending of ["completes", ...saga.rejects.map((tag) => `fails with ${tag}`)])
        endings.set(`${saga.name} ${ending}`, { saga: saga.name, ending, story: undefined });
    const followed = new Set<string>();
    const ran = new Set<string>();
    const unread = new Map<string, Value.NotTranslated>();
    const disagreements = new Set<string>();
    const undecided = new Map<string, number>();
    const gaveUp = (reason: string) => undecided.set(reason, (undecided.get(reason) ?? 0) + 1);
    let states = 0;
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
      readonly sagas: ReadonlyArray<SagaRun>;
      readonly timers: ReadonlyArray<Timer>;
      /** The commands callers sent and the schedules that came due. */
      readonly length: number;
    }

    const begin = (from: Open): Sequence => ({
      trail: [...from.trail],
      instances: [...from.instances],
      queue: [],
      sagas: [...from.sagas],
      timers: [...from.timers],
      failures: [],
      endings: [],
      unsettled: false,
      rules: [],
    });
    const nothing: Open = {
      run: new Value.Run([]),
      trail: [],
      instances: [],
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
    let working:
      | {
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
        const sent = { by: timer ? timer.by : reacting, after: timer?.after };
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
            ...sent,
          });
          return applied;
        }
        const checks =
          agg.invariants.length > 0
            ? yield* Paths.checks(interpreter, agg.definition, applied.state)
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
          ...sent,
        });
        for (const event of applied.events) {
          const cls = event._tag === "Obj" ? event.brand?.cls : undefined;
          for (const policy of policies)
            if (policy.from === agg.cls && policy.on.includes(cls))
              sequence.queue.push({ policy, instance: index, event, parent: at });
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
      sequence.instances.push({
        agg,
        id: pin(address, `${agg.name}#${made}.id`),
        state: agg.initial,
        version: 0,
      });
      return sequence.instances.length - 1;
    };

    /** A command and where it goes, as a policy or saga wrote them. */
    const addressed = (
      agg: Agg,
      target: V | undefined,
      command: V | undefined,
      site: Site,
      verb: string,
    ) => {
      const cls =
        command?._tag === "Obj" && command.brand?.kind === "Command"
          ? (command.brand.cls as CommandClass)
          : undefined;
      if (!command || !cls)
        return Effect.fail(
          Value.notTranslated(site, `${verb} ${agg.name} something that is not a command`),
        );
      if (!agg.commands.includes(cls))
        return Effect.fail(
          Value.notTranslated(site, `${verb} ${cls.tag} to ${agg.name}, which does not take it`),
        );
      const address = target?._tag === "Obj" ? target.fields.id : target;
      const text = textOf(address);
      if (!address || text === undefined)
        return Effect.fail(
          Value.notTranslated(site, `${verb} ${cls.tag} to an address the explorer cannot follow`),
        );
      return Effect.succeed({ cls, command, address, text });
    };

    /** Whether two addresses are the same one. Symbolic ones split the path. */
    const same = (a: V, b: V): boolean => {
      const [left, right] = [textOf(a)!, textOf(b)!];
      if (left === right) return true;
      if (a._tag === "Str" && b._tag === "Str") return false;
      return interpreter.current.run.branch(`(= ${left} ${right})`);
    };

    const send: (agg: Agg, target: V | undefined, command: V | undefined, site: Site) => Eval<V> =
      Effect.fnUntraced(function* (
        agg: Agg,
        target: V | undefined,
        command: V | undefined,
        site: Site,
      ) {
        const to = yield* addressed(agg, target, command, site, "sends");
        const index = resolve(agg, to.address, to.text);
        const applied = yield* apply(
          agg,
          index,
          to.cls,
          pin(to.command, `${sequence.trail.length + 1}.command`),
        );
        if (applied._tag === "Rejected")
          return yield* new Value.Rejected({ rejection: applied.rejection });
        return Value.obj({
          version: Value.num(sequence.instances[index]!.version),
          events: { _tag: "Arr", items: applied._tag === "Changed" ? applied.events : [] },
          reply: Value.undef,
        });
      });

    /** Keep a command for later. It runs as a step of its own once its delay has passed. */
    const schedule: (
      agg: Agg,
      target: V | undefined,
      command: V | undefined,
      options: V | undefined,
      site: Site,
    ) => Eval<V> = Effect.fnUntraced(function* (
      agg: Agg,
      target: V | undefined,
      command: V | undefined,
      options: V | undefined,
      site: Site,
    ) {
      const to = yield* addressed(agg, target, command, site, "schedules");
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
      return Value.obj({
        commandId: Value.str(commandId),
        at: { _tag: "Time", millis: { sort: "Int", text: `(+ ${since} ${millis})` } },
      });
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
          send: native(`${agg.name}.send`, ([target, command], site) =>
            Effect.succeed<V>({
              _tag: "Effect",
              run: Effect.suspend(() => send(agg, target, command, site)),
            }),
          ),
          schedule: native(`${agg.name}.schedule`, ([target, command, options], site) =>
            Effect.succeed(effect(() => schedule(agg, target, command, options, site))),
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
      const saga = sagaClients.get(host);
      if (saga) return saga;
      const kind =
        typeof host === "function" ? (host as { readonly kind?: unknown }).kind : undefined;
      return kind === "Saga"
        ? { _tag: "Opaque", what: "a saga" }
        : kind === "ExternalSystem"
          ? { _tag: "Opaque", what: "an external system" }
          : undefined;
    };

    // An activity runs once: a run that goes on after a signal reads what it gave.
    interpreter.hooks.models.set("effect/workflow:Activity.make", ([options], site) => {
      const fields = options?._tag === "Obj" ? options.fields : undefined;
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
          return execute.run.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                frame.journal.set(name.value, { _tag: "Success", value });
              }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error._tag !== "Rejected" || error.rejection === SUSPENDED) return;
                frame.journal.set(name.value, { _tag: "Failure", rejection: error.rejection });
                if (declares) return;
                frame.flagged.add(error.rejection);
                sequence.failures.push({
                  policy: reacting ?? "a saga",
                  tag: `${tagOf(error.rejection) ?? "an error"} in the activity ${name.value}, which declares no error`,
                });
              }),
            ),
          );
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
      ran.add(saga.name);
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
        const site: Site = { module: policy.module, node: policy.node };
        const instance = sequence.instances[trigger.instance]!;
        const parent = sequence.trail[trigger.parent]!;
        const source = Value.obj({ aggregate: Value.str(instance.agg.name), id: instance.id });
        reacting = policy.name;
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
                    envelope: Value.obj({
                      id: instance.id,
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
        followed.add(policy.name);
        if (rejection)
          sequence.failures.push({ policy: policy.name, tag: tagOf(rejection) ?? "an error" });
      }
    });

    /** The solver's values as real commands, run one after another on the real code. */
    const replay = Effect.fn(function* (played: Sequence, run: Value.Run, model: Check.Model) {
      const build = (what: string, value: V) => {
        const built = Symbolic.concretize(value, model);
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
      const breaks: Array<{ readonly name: string; readonly at: number; readonly rule?: true }> =
        [];
      for (const [at, entry] of played.trail.entries()) {
        const slot = real[entry.instance]!;
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
        const read: Array<{ name: string; value: unknown }> = [];
        for (const [key, held] of run.contexts) {
          if (!key.startsWith(entry.label)) continue;
          const value = yield* build(key, held.value);
          context = Context.add(context, held.tag as Context.Key<unknown, unknown>, value);
          read.push({ name: key.slice(key.lastIndexOf("/") + 1), value });
        }
        const now = (yield* build("now", entry.inputs.now)) as DateTime.Utc;
        const prediction = Aggregate.predict(entry.agg.cls, slot.state, command, {
          id: slot.id,
          now,
          version: slot.version,
          commandId: (yield* build("commandId", entry.inputs.commandId)) as string,
          context: context as Context.Context<never>,
        });
        const where = `step ${at + 1}, ${Symbolic.show(command)} to ${entry.agg.name} ${Symbolic.show(slot.id)}`;
        if (prediction._tag === "Unpredictable")
          return yield* new Disagreement({
            reason: `the real code fails on ${where}: ${Cause.pretty(prediction.cause)}`,
          });
        const expected =
          entry.applied._tag === "Rejected"
            ? `rejects with ${tagOf(entry.applied.rejection)}`
            : `records [${(entry.applied._tag === "Changed" ? entry.applied.events : []).map(tagOf).join(", ")}]`;
        const actual =
          prediction._tag === "Rejected"
            ? `rejects with ${prediction.rejection._tag}`
            : `records [${prediction.events.map((event) => event._tag).join(", ")}]`;
        if (expected !== actual)
          return yield* new Disagreement({
            reason: `the explorer read that ${where} ${expected}, but the real code ${actual}`,
          });
        const who = { aggregate: entry.agg.name, id: slot.id, by: entry.by, after: entry.after };
        if (prediction._tag === "Rejected") {
          story.push({
            ...who,
            command,
            context: read,
            now,
            outcome: { _tag: "Rejected", rejection: prediction.rejection },
          });
          continue;
        }
        slot.state = prediction.state;
        slot.version += prediction.events.length;
        slot.events.push(...prediction.events);
        story.push({
          ...who,
          command,
          context: read,
          now,
          outcome: { _tag: "Accepted", events: prediction.events, state: prediction.state },
        });
        for (const [name, holds] of Object.entries(entry.agg.real))
          if (holds(prediction.state) !== true)
            breaks.push({ name: `${entry.agg.name}.${name}`, at });
      }
      if (played.rules.length > 0) {
        // The same sequence on the real code, and the model's real invariants on what it left.
        const model = Object.fromEntries(
          aggs.map((agg) => [
            agg.name,
            real.flatMap((slot) =>
              slot.agg === agg ? [{ id: slot.id, state: slot.state, events: slot.events }] : [],
            ),
          ]),
        );
        for (const name of located.rules.names) {
          const holds = yield* Effect.try({
            try: () => located.rules.real[name]?.(model),
            catch: (cause) =>
              new Disagreement({
                reason: `the model's invariant ${name} fails on the real code: ${String(cause)}`,
              }),
          });
          if (holds === false) breaks.push({ name, at: played.trail.length - 1, rule: true });
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
      for (const wishes of [[...still, ...named], still]) {
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
          const name = `${entry.agg.name}.${entry.command.tag} ${kind} ${tag}`;
          if (!outcomes.has(name))
            outcomes.set(name, {
              aggregate: entry.agg.name,
              command: entry.command.tag,
              kind,
              tag,
              story: undefined,
            });
          const outcome = outcomes.get(name)!;
          if (shorter(outcome.story, length))
            wants.push((story) => {
              if (shorter(outcome.story, length)) outcome.story = story.slice(0, length);
            });
        };
        if (applied._tag === "Rejected") want("rejects", tagOf(applied.rejection));
        if (applied._tag === "Changed") {
          for (const event of applied.events) want("records", tagOf(event));
          const state = reached.get(`${entry.agg.name} ${tagOf(applied.state)}`);
          if (state && shorter(state.story, length))
            wants.push((story) => {
              if (shorter(state.story, length)) state.story = story.slice(0, length);
            });
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
                story: story.slice(0, ended.at),
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
        for (const check of entry.checks) {
          if (Result.isFailure(check.condition)) {
            const error = check.condition.failure;
            unread.set(`${error.file}:${error.line}`, error);
          } else if (
            check.condition.success !== "true" &&
            !kept.get(`${entry.agg.name}.${entry.command.tag}`)?.has(check.name) &&
            shorter(broken.get(`${entry.agg.name}.${check.name}`)?.story, at + 1)
          ) {
            open.push(check.condition.success);
          }
        }
      }
      for (const check of played.rules) {
        if (Result.isFailure(check.condition)) {
          const error = check.condition.failure;
          unread.set(`${error.file}:${error.line}`, error);
        } else if (
          check.condition.success !== "true" &&
          shorter(ruled.get(check.name), played.trail.length)
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
              if (shorter(ruled.get(found.name), found.at + 1))
                ruled.set(found.name, replayed!.story.slice(0, found.at + 1));
              continue;
            }
            const entry = broken.get(found.name);
            if (entry && shorter(entry.story, found.at + 1))
              entry.story = replayed!.story.slice(0, found.at + 1);
          }
        }
      }
      return true;
    });

    /** Every instance in a sequence, by aggregate, with its state and the events it recorded. */
    const world = (played: Sequence): V =>
      Value.obj(
        Object.fromEntries(
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
                            entry.instance === index && entry.applied._tag === "Changed"
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
      );

    /** Every way one move can go from a sequence, with the reactions to it. */
    const play = Effect.fn(function* (
      from: Open,
      longer: Array<Open>,
      move: (run: Value.Run) => Eval<unknown>,
    ) {
      let prefix: ReadonlyArray<number> | undefined = [];
      while (prefix) {
        if (sequences >= options.budget) {
          truncated = true;
          return;
        }
        const run = from.run.fork(prefix);
        interpreter.current.run = run;
        interpreter.hooks.provided.clear();
        sequence = begin(from);
        reacting = undefined;
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
            ? yield* Paths.checks(interpreter, located.rules.definition, world(played)).pipe(
                Effect.result,
              )
            : Result.succeed([]);
        prefix = Value.nextPrefix(run.taken);
        if (Result.isFailure(rules)) {
          sequences++;
          continue;
        }
        played.rules = rules.success;
        const canGoOn = changed && !played.unsettled && from.length + 1 < options.depth;
        moving = from.length + 1;
        const feasible = yield* visit(run, played, from.trail.length, canGoOn);
        if (feasible && canGoOn)
          longer.push({
            run,
            trail: played.trail,
            instances: played.instances,
            sagas: played.sagas,
            timers: played.timers,
            length: from.length + 1,
          });
        else sequences++;
      }
    });

    /** Every sequence one move longer than this one: a caller's command, or a schedule that comes due. */
    const extend = Effect.fn(function* (from: Open, longer: Array<Open>) {
      for (const { agg, command } of externals) {
        const existing = from.instances.flatMap((instance, index) =>
          instance.agg === agg ? [index] : [],
        );
        const targets: ReadonlyArray<number | undefined> = [
          ...existing,
          ...(existing.length < options.instances ? [undefined] : []),
        ];
        for (const target of targets) {
          yield* play(from, longer, (run) => {
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
          if (truncated) return;
        }
      }
      for (const [at, timer] of from.timers.entries()) {
        yield* play(from, longer, () => {
          sequence.timers = sequence.timers.filter((_, index) => index !== at);
          const index = resolve(timer.agg, timer.address, textOf(timer.address)!);
          return apply(timer.agg, index, timer.cls, timer.command, timer);
        });
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

    const found: Found = {
      sequences,
      states,
      truncated,
      complete,
      invariants: [...broken.values()].map((entry) => ({
        aggregate: entry.aggregate,
        name: entry.name,
        broken: entry.story,
        proved:
          !entry.story &&
          byClass.size > 0 &&
          aggs
            .find((agg) => agg.name === entry.aggregate)!
            .commands.every(
              (command) => kept.get(`${entry.aggregate}.${command.tag}`)?.has(entry.name) === true,
            ),
      })),
      rules: [...ruled].map(([name, story]) => ({ name, broken: story })),
      outcomes: [...outcomes.values()],
      reached: [...reached.values()],
      followed: [...followed],
      idle: policies.flatMap((policy) => (followed.has(policy.name) ? [] : [policy.name])),
      sagas: [...ran],
      unstarted: sagas.flatMap((saga) => (ran.has(saga.name) ? [] : [saga.name])),
      endings: [...endings.values()],
      skipped: [...located.skipped, ...skipped.values()],
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
