import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import type * as Compaction from "../../Compaction.ts";
import type * as Rewrite from "../../Rewrite.ts";
import type { Verdict } from "./Check.ts";
import * as Check from "./Check.ts";
import * as Compare from "./Compare.ts";
import * as Induction from "./Induction.ts";
import type { Interpreter } from "./Interpreter.ts";
import * as Paths from "./Paths.ts";
import type * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import type { Eval, Module, Node, V } from "./Value.ts";
import * as Value from "./Value.ts";

/** What a file passes to `Domain.Compaction` or `Domain.Rewrite`: the object, as written. */
export interface Written {
  readonly module: Module;
  readonly node: Node;
  readonly name: string;
}

/** A compaction's definition, in whichever of the files declares it. */
export const compactionIn = (
  modules: ReadonlyArray<Module>,
  compaction: Compaction.Any,
): Written | undefined => {
  for (const module of modules) {
    if (!Object.values(module.exports).includes(compaction)) continue;
    const node = Paths.find(module.program, compaction.compactionName, "rollup");
    if (node) return { module, node, name: compaction.compactionName };
  }
  return undefined;
};

/** A rewrite's definition, in whichever of the files declares it. */
export const rewriteIn = (
  modules: ReadonlyArray<Module>,
  rewrite: Rewrite.Any,
): Written | undefined => {
  for (const module of modules) {
    if (!Object.values(module.exports).includes(rewrite)) continue;
    const node = Paths.find(module.program, rewrite.rewriteName, "of");
    if (node) return { module, node, name: rewrite.rewriteName };
  }
  return undefined;
};

const formula = (known: Compare.Known): string | undefined =>
  known === undefined ? undefined : typeof known === "boolean" ? String(known) : known;

const forcing =
  (run: Value.Run) =>
  (list: V): V =>
    list._tag === "List" ? Symbolic.force(list, run) : list;

type RealEvolve = Record<string, (state: unknown, event: unknown, envelope: unknown) => unknown>;

/** A state after events, each folded with the aggregate's real `evolve`. */
const realFold = (
  aggregate: Aggregate.Any,
  state: unknown,
  events: ReadonlyArray<{ readonly _tag: string }>,
  id: unknown,
  version: number,
): unknown => {
  const evolve = aggregate.definition.evolve as unknown as RealEvolve;
  const stream = `${aggregate.aggregateName}/${String(id)}`;
  return events.reduce<unknown>(
    (folded, event, index) =>
      evolve[event._tag]!(folded, event, {
        id,
        stream,
        seq: version + index + 1,
        at: DateTime.makeUnsafe(0),
        commandId: "prove",
        correlationId: "prove",
      }),
    state,
  );
};

const attempt = <A>(what: string, evaluate: () => A): Effect.Effect<A, Verdict> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => Check.notConfirmed(`${what}: ${String(cause)}`),
  });

/** What one roll-up does, from any state the aggregate's rules allow. */
export interface CompactionRow {
  /** The paths through the roll-up that were checked. */
  readonly paths: number;
  /** Whether folding the roll-up from `initial` gives the state back. */
  readonly lossless: Verdict;
  /** Whether folding the roll-up onto the state it was made from leaves that state. */
  readonly standing: Verdict;
}

/** The events a roll-up gives for a state, in the interpreter's current run. */
const rolled = (
  interpreter: Interpreter,
  definition: Paths.Definition,
  written: Written,
  state: V,
  id: V,
  version: V,
): Eval<ReadonlyArray<V>> =>
  Effect.gen(function* () {
    const site = Paths.siteOf(written);
    const node = Paths.property(written, "rollup");
    if (!node) return yield* Value.notTranslated(site, `${written.name} has no rollup`);
    const rollup = yield* interpreter.evaluate(node, interpreter.moduleEnv(written.module));
    const made = yield* Paths.strict(
      interpreter.call(rollup, [state, Value.obj({ id, version })], site),
      site,
      `the rollup of ${written.name}`,
    );
    if (made._tag !== "Arr")
      return yield* Value.notTranslated(
        site,
        `the rollup of ${written.name} gives something that is not a list of ${definition.name}'s events`,
      );
    return made.items;
  });

/**
 * Take a roll-up from any state that satisfies every invariant, along every
 * path through its code, and say whether folding it gives that state back:
 * from `initial`, as an instance read after the compaction folds it, and onto
 * the state itself, as the instance does when it commits it.
 */
export const compaction = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  cls: Compaction.Any,
  written: Written,
) {
  let lossless: Verdict = { _tag: "Proved" };
  let standing: Verdict = { _tag: "Proved" };
  const both = (verdict: Verdict) => {
    lossless = Induction.worse(lossless, verdict);
    standing = Induction.worse(standing, verdict);
  };
  let paths = 0;
  let prefix: ReadonlyArray<number> | undefined = [];
  while (prefix) {
    if (++paths > Induction.MAX_PATHS) {
      both({
        _tag: "Unknown",
        reason: `${written.name} has more than ${Induction.MAX_PATHS} paths`,
      });
      break;
    }
    const run = new Value.Run(prefix);
    interpreter.current.run = run;
    const taken = yield* Effect.gen(function* () {
      const state = yield* Paths.assumed(interpreter, definition, "state");
      const versionTerm = run.constant("version", "Int");
      run.assume(`(>= ${versionTerm.text} 0)`);
      const version: V = { _tag: "Term", term: versionTerm };
      const id: V = { _tag: "Term", term: run.constant("id", "String") };
      const events = yield* rolled(interpreter, definition, written, state, id, version);
      const { commandId, now } = Paths.stamp("", run);
      const on = {
        id,
        stream: Value.term("String", `(str.++ "${definition.name}/" ${Paths.addressOf(id)})`),
        version,
        now,
        commandId,
      };
      const what = `the rollup of ${written.name}`;
      const fresh = yield* Paths.folded(
        interpreter,
        definition,
        what,
        yield* Paths.initial(interpreter, definition),
        events,
        on,
      );
      const onto = yield* Paths.folded(interpreter, definition, what, state, events, on);
      const force = forcing(run);
      return {
        state,
        id,
        version,
        lossless: formula(Compare.equals(fresh, state, force)),
        standing: formula(Compare.equals(onto, state, force)),
      };
    }).pipe(
      Effect.map((made) => ({ _tag: "Ran", ...made }) as const),
      Effect.catchTags({
        Infeasible: () => Effect.succeed({ _tag: "Infeasible" } as const),
        NotTranslated: (error) => Effect.succeed({ _tag: "Stopped", error } as const),
        Rejected: () => Effect.succeed({ _tag: "Infeasible" } as const),
      }),
    );
    prefix = Value.nextPrefix(run.taken);
    if (taken._tag === "Stopped") {
      const unread = Induction.notRead(taken.error);
      both(unread);
    }
    if (taken._tag !== "Ran") continue;
    const judge = (condition: string | undefined, from: "initial" | "state") =>
      condition === undefined
        ? Effect.succeed<Verdict>({
            _tag: "Unknown",
            reason: `the prover cannot compare the state the roll-up folds to with the one it was made from`,
          })
        : Check.checkAt(solver, run, condition, (build) =>
            Effect.gen(function* () {
              const state = yield* build("state", taken.state);
              if (!Schema.is(aggregate.definition.state)(state))
                return yield* Effect.fail(
                  Check.notConfirmed(
                    `the solver's state ${Symbolic.show(state)} is not one the state's schema allows`,
                  ),
                );
              const id = yield* build("id", taken.id);
              const version = (yield* build("version", taken.version)) as number;
              const events = yield* attempt(`the rollup of ${written.name} threw`, () =>
                (
                  cls.definition.rollup as unknown as (
                    state: unknown,
                    ctx: unknown,
                  ) => ReadonlyArray<{ readonly _tag: string }>
                )(state, { id, version }),
              );
              const after = yield* attempt("evolve threw on the roll-up", () =>
                realFold(
                  aggregate,
                  from === "initial" ? aggregate.definition.initial : state,
                  events,
                  id,
                  version,
                ),
              );
              if (Check.canon(after) === Check.canon(state))
                return Check.notConfirmed(
                  `the solver found ${Symbolic.show(state)}, but the real roll-up folds back to it`,
                );
              const verdict: Verdict = {
                _tag: "Violated",
                counterexample: {
                  state,
                  command: { _tag: written.name },
                  context: [],
                  events,
                  after,
                },
              };
              return verdict;
            }),
          ).pipe(Effect.map((verdict) => Induction.within(verdict, run)));
    lossless = Induction.worse(lossless, yield* judge(taken.lossless, "initial"));
    standing = Induction.worse(standing, yield* judge(taken.standing, "state"));
  }
  const row: CompactionRow = { paths, lossless, standing };
  return row;
});

/** A source of events a rewrite is taken through: a command, or a compaction's roll-up. */
export type Source =
  | { readonly _tag: "Command"; readonly command: Paths.CommandClass }
  | { readonly _tag: "Rollup"; readonly cls: Compaction.Any; readonly written: Written };

const nameOf = (source: Source): string =>
  source._tag === "Command" ? source.command.tag : source.written.name;

/** What a rewrite does to the events one source records. */
export interface RewriteRow {
  /** The command that records the events, or the compaction whose roll-up they are. */
  readonly step: string;
  /** The paths through it and the rewrite's handlers that were checked. */
  readonly paths: number;
  /** Whether the state the rewritten events fold to is one the state's schema allows. */
  readonly fits: Verdict;
  /** Each invariant, on the state the rewritten events fold to. */
  readonly verdicts: ReadonlyMap<string, Verdict>;
}

/** Each event as a rewrite leaves it: kept, replaced, or removed. */
const rewritten = (
  interpreter: Interpreter,
  written: Written,
  events: ReadonlyArray<V>,
  input: V,
  on: {
    readonly id: V;
    readonly stream: V;
    readonly version: V;
    readonly now: V;
    readonly commandId: V;
  },
): Eval<ReadonlyArray<V>> =>
  Effect.gen(function* () {
    const site = Paths.siteOf(written);
    const node = Paths.property(written, "events");
    const handlers = node
      ? yield* interpreter.evaluate(node, interpreter.moduleEnv(written.module))
      : Value.obj({});
    const made: Array<V> = [];
    for (const [index, event] of events.entries()) {
      const tag =
        event._tag === "Obj" && event.brand?.kind === "Event" ? event.fields._tag : undefined;
      if (tag?._tag !== "Str")
        return yield* Value.notTranslated(site, "an event to rewrite is not an event");
      const handler = yield* interpreter.member(handlers, tag.value, site);
      if (handler._tag === "Undef") {
        made.push(event);
        continue;
      }
      const envelope = Value.obj({
        id: on.id,
        stream: on.stream,
        seq:
          on.version._tag === "Term"
            ? Value.term("Int", `(+ ${on.version.term.text} ${index + 1})`)
            : on.version,
        at: on.now,
        commandId: on.commandId,
        correlationId: on.commandId,
      });
      const next = yield* Paths.strict(
        interpreter.call(handler, [event, input, envelope], site),
        site,
        `${written.name} for ${tag.value}`,
      );
      if (next._tag === "Null") continue;
      if (next._tag !== "Obj" || next.brand?.kind !== "Event")
        return yield* Value.notTranslated(
          site,
          `${written.name} for ${tag.value} gives something that is not an event or null`,
        );
      made.push(next);
    }
    return made;
  });

/** The fields of a state's schema, when it is a struct the prover holds as an object. */
const fieldsOf = (state: V): ReadonlyArray<string> | undefined =>
  state._tag === "Obj" && state.brand === undefined ? Object.keys(state.fields) : undefined;

/** Whether two states are objects of the same fields: a state that is one of several shapes may not be. */
const alike = (a: V, b: V): boolean => {
  const x = fieldsOf(a);
  const y = fieldsOf(b);
  return (
    x !== undefined && y !== undefined && x.length === y.length && x.every((key) => y.includes(key))
  );
};

interface Ran {
  readonly state: V;
  /** What the rewritten history has folded to before these events. */
  readonly other: V;
  readonly input: V;
  readonly id: V;
  readonly version: V;
  readonly command: V | undefined;
  readonly commandId: V | undefined;
  readonly now: V | undefined;
  readonly after: V;
  readonly afterRewritten: V;
}

/**
 * One source's events on one path: recorded from any state the rules allow,
 * rewritten, and folded onto the state the rewritten history has reached.
 * That state is any the rules allow that is the recorded one in every part
 * outside `differs`.
 */
const taken = (
  interpreter: Interpreter,
  definition: Paths.Definition,
  rewrite: Rewrite.Any,
  written: Written,
  source: Source,
  differs: ReadonlySet<string> | "all",
): Eval<Ran | undefined> =>
  Effect.gen(function* () {
    const run = interpreter.current.run;
    const site = Paths.siteOf(definition);
    const ast = Symbolic.typeOf(definition.state);
    if (!ast) return yield* Value.notTranslated(site, "the state is not a schema");
    const state = yield* Paths.assumed(interpreter, definition, "state");
    const fresh = Symbolic.symbolic(ast, "rewritten", run);
    const plain = (value: V) => value._tag === "Obj" && value.brand === undefined;
    let other = fresh;
    if (differs !== "all" && plain(state) && plain(fresh)) {
      if (alike(state, fresh) && state._tag === "Obj" && fresh._tag === "Obj")
        other = Value.obj(
          Object.fromEntries(
            Object.keys(state.fields).map((key) => [
              key,
              differs.has(key) ? fresh.fields[key]! : state.fields[key]!,
            ]),
          ),
        );
      // A state of several shapes: the rewritten one has another only where the rewrite can change which.
      else if (!differs.has("_tag")) return yield* new Value.Infeasible();
    }
    // Assume: the state the rewritten history has reached satisfies every invariant.
    for (const check of yield* Paths.checks(interpreter, definition, other).pipe(
      Effect.catchTag("NotTranslated", () => Effect.succeed<ReadonlyArray<Paths.Check>>([])),
    )) {
      if (Result.isFailure(check.condition)) continue;
      if (check.condition.success === "false") return yield* new Value.Infeasible();
      run.assume(check.condition.success);
    }
    const versionTerm = run.constant("version", "Int");
    run.assume(`(>= ${versionTerm.text} 0)`);
    const version: V = { _tag: "Term", term: versionTerm };

    let events: ReadonlyArray<V>;
    let id: V;
    let command: V | undefined;
    let commandId: V;
    let now: V;
    if (source._tag === "Command") {
      const step = yield* Paths.step(interpreter, definition, source.command, state, version, "");
      if (step.applied._tag !== "Changed") return undefined;
      events = step.applied.events;
      id = step.inputs.id;
      command = step.inputs.command;
      commandId = step.inputs.commandId;
      now = step.inputs.now;
    } else {
      id = { _tag: "Term", term: run.constant("id", "String") };
      events = yield* rolled(interpreter, definition, source.written, state, id, version);
      const stamped = Paths.stamp("", run);
      commandId = stamped.commandId;
      now = stamped.now;
    }
    const on = {
      id,
      stream: Value.term("String", `(str.++ "${definition.name}/" ${Paths.addressOf(id)})`),
      version,
      now,
      commandId,
    };
    const fields: Record<string, V> = { _tag: Value.str(rewrite.rewriteName) };
    for (const [key, schema] of Object.entries(
      (rewrite as unknown as { readonly fields: Readonly<Record<string, unknown>> }).fields,
    )) {
      const field = Symbolic.typeOf(schema);
      if (key !== "_tag" && field) fields[key] = Symbolic.symbolic(field, `rewrite.${key}`, run);
    }
    const input = Value.obj(fields);
    const what = nameOf(source);
    const after = yield* Paths.folded(interpreter, definition, what, state, events, on);
    const afterRewritten = yield* Paths.folded(
      interpreter,
      definition,
      `${written.name} of ${what}`,
      other,
      yield* rewritten(interpreter, written, events, input, on),
      on,
    );
    return {
      state,
      other,
      input,
      id,
      version,
      command,
      commandId: source._tag === "Command" ? commandId : undefined,
      now: source._tag === "Command" ? now : undefined,
      after,
      afterRewritten,
    };
  });

/** Every path of one source, each run with `visit`. */
const eachPath = Effect.fn(function* (
  interpreter: Interpreter,
  what: string,
  body: () => Eval<Ran | undefined>,
  visit: (
    outcome:
      | { readonly _tag: "Ran"; readonly ran: Ran; readonly run: Value.Run }
      | { readonly _tag: "Stopped"; readonly verdict: Verdict },
  ) => Effect.Effect<void, Smt.SolverError>,
) {
  let paths = 0;
  let prefix: ReadonlyArray<number> | undefined = [];
  while (prefix) {
    if (++paths > Induction.MAX_PATHS) {
      yield* visit({
        _tag: "Stopped",
        verdict: { _tag: "Unknown", reason: `${what} has more than ${Induction.MAX_PATHS} paths` },
      });
      break;
    }
    const run = new Value.Run(prefix);
    interpreter.current.run = run;
    const outcome = yield* body().pipe(
      Effect.map((ran) => (ran ? ({ _tag: "Ran", ran } as const) : ({ _tag: "None" } as const))),
      Effect.catchTags({
        Infeasible: () => Effect.succeed({ _tag: "None" } as const),
        NotTranslated: (error) => Effect.succeed({ _tag: "Stopped", error } as const),
        Rejected: () => Effect.succeed({ _tag: "None" } as const),
      }),
    );
    prefix = Value.nextPrefix(run.taken);
    if (outcome._tag === "Stopped")
      yield* visit({ _tag: "Stopped", verdict: Induction.notRead(outcome.error) });
    if (outcome._tag === "Ran") yield* visit({ _tag: "Ran", ran: outcome.ran, run });
  }
  return paths;
});

/**
 * The parts of the state a rewrite can leave other than they were: the
 * top-level fields of the state where, on some path, the rewritten events
 * fold to something else than the recorded ones, given states that already
 * differ only in such parts. `"all"` where the state is not a struct, or
 * where the prover cannot tell.
 */
const differing = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  definition: Paths.Definition,
  rewrite: Rewrite.Any,
  written: Written,
  sources: ReadonlyArray<Source>,
) {
  let differs = new Set<string>();
  let whole = false;
  // Each round adds at least one field, or is the last.
  for (;;) {
    const found = new Set<string>(differs);
    for (const source of sources) {
      yield* eachPath(
        interpreter,
        nameOf(source),
        () => taken(interpreter, definition, rewrite, written, source, differs),
        (outcome) =>
          Effect.gen(function* () {
            // Unread: nothing is known of what the rewrite leaves alone.
            if (outcome._tag === "Stopped") {
              whole = true;
              return;
            }
            const { ran, run } = outcome;
            const fields = fieldsOf(ran.after);
            const others = fieldsOf(ran.afterRewritten);
            if (!fields || !others) {
              whole = true;
              return;
            }
            // The rewritten events fold to another shape of the state: everything may differ.
            if (!alike(ran.after, ran.afterRewritten)) {
              found.add("_tag");
              for (const key of [...fields, ...others]) found.add(key);
              return;
            }
            const force = forcing(run);
            for (const key of fields) {
              if (found.has(key)) continue;
              const a = ran.after._tag === "Obj" ? ran.after.fields[key] : undefined;
              const b =
                ran.afterRewritten._tag === "Obj" ? ran.afterRewritten.fields[key] : undefined;
              const same = a && b ? formula(Compare.equals(a, b, force)) : undefined;
              if (same === "true") continue;
              if (same === undefined || same === "false") {
                found.add(key);
                continue;
              }
              const answer = yield* Check.solve(solver, run, same);
              if (answer._tag !== "Unsat") found.add(key);
            }
          }),
      );
      if (whole) return "all" as const;
    }
    if (found.size === differs.size) return differs;
    differs = found;
  }
});

/**
 * Take a rewrite through every event an instance can hold. Each command, and
 * each roll-up, records its events from any state the rules allow; the
 * rewrite's handlers are run on them, and what they leave is folded onto the
 * state the rewritten history has reached: any the rules allow that is the
 * recorded one outside the parts the rewrite can change. Where every
 * invariant holds after that, on every path, no history the commands can
 * record is rewritten into one that breaks an invariant.
 */
export const rewrite = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  cls: Rewrite.Any,
  written: Written,
  sources: ReadonlyArray<Source>,
) {
  const names = Paths.invariantNames(definition);
  const differs = yield* differing(solver, interpreter, definition, cls, written, sources);
  const real = (aggregate.definition.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
  const handlers = (cls.definition.events ?? {}) as unknown as Record<
    string,
    | ((event: unknown, input: unknown, envelope: unknown) => { readonly _tag: string } | null)
    | undefined
  >;
  const rows: Array<RewriteRow> = [];
  // Nothing of the state differs: the rewritten history folds to the states the
  // recorded one did, and each of those is one a command left.
  const unchanged = differs !== "all" && differs.size === 0;
  for (const source of unchanged ? [] : sources) {
    const verdicts = new Map<string, Verdict>(names.map((name) => [name, { _tag: "Proved" }]));
    let fits: Verdict = { _tag: "Proved" };
    const all = (verdict: Verdict) => {
      for (const name of names) verdicts.set(name, Induction.worse(verdicts.get(name)!, verdict));
      fits = Induction.worse(fits, verdict);
    };
    const stateAst = Symbolic.typeOf(definition.state)!;
    const paths = yield* eachPath(
      interpreter,
      nameOf(source),
      () => taken(interpreter, definition, cls, written, source, differs),
      (outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Stopped") return all(outcome.verdict);
          const { ran, run } = outcome;
          if (run.bounds.size > 0) all(Induction.within({ _tag: "Proved" }, run));
          const confirm =
            (holds: (state: unknown) => boolean, what: string) =>
            (build: Check.Build): Effect.Effect<Verdict, Verdict> =>
              Effect.gen(function* () {
                const state = yield* build("state", ran.state);
                const other = yield* build("rewritten state", ran.other);
                for (const [label, value] of [
                  ["state", state],
                  ["rewritten state", other],
                ] as const) {
                  if (!Schema.is(aggregate.definition.state)(value))
                    return yield* Effect.fail(
                      Check.notConfirmed(
                        `the solver's ${label} ${Symbolic.show(value)} is not one the state's schema allows`,
                      ),
                    );
                  for (const [name, rule] of Object.entries(real))
                    if (
                      !(yield* attempt(`${name} threw on the solver's ${label}`, () => rule(value)))
                    )
                      return yield* Effect.fail(
                        Check.notConfirmed(
                          `the solver's ${label} ${Symbolic.show(value)} already breaks ${name}, which the prover could not read`,
                        ),
                      );
                }
                const id = yield* build("id", ran.id);
                const version = (yield* build("version", ran.version)) as number;
                const { _tag: _name, ...given } = (yield* build("rewrite", ran.input)) as {
                  readonly _tag: string;
                };
                const input = yield* attempt(
                  `${written.name} refuses the solver's input ${Symbolic.show(given)}`,
                  () =>
                    new (cls as unknown as new (fields: object) => { readonly _tag: string })(
                      given,
                    ),
                );
                let events: ReadonlyArray<{ readonly _tag: string }>;
                let command: unknown = { _tag: written.name };
                let now: DateTime.Utc | undefined;
                if (source._tag === "Command") {
                  const { _tag: tag, ...fields } = (yield* build("command", ran.command!)) as {
                    readonly _tag: string;
                  };
                  const made = aggregate.definition.commands.find(
                    (c) => c.tag === tag,
                  ) as unknown as new (fields: object) => { readonly _tag: string };
                  command = yield* attempt(
                    `${tag} refuses the solver's input ${Symbolic.show(fields)}`,
                    () => new made(fields),
                  );
                  let context = Context.empty() as Context.Context<unknown>;
                  for (const [key, entry] of run.contexts) {
                    const value = yield* build(key, entry.value);
                    context = Context.add(
                      context,
                      entry.tag as Context.Key<unknown, unknown>,
                      value,
                    );
                  }
                  now = (yield* build("now", ran.now!)) as DateTime.Utc;
                  const commandId = (yield* build("commandId", ran.commandId!)) as string;
                  const prediction = yield* attempt(`${tag} threw`, () =>
                    Aggregate.predict(aggregate, state, command as { readonly _tag: string }, {
                      now: now!,
                      version,
                      commandId,
                      context: context as Context.Context<never>,
                    }),
                  );
                  if (prediction._tag === "Rejected")
                    return Check.notConfirmed(
                      `the solver found ${Symbolic.show(command)} on ${Symbolic.show(state)}, but the real code rejects it`,
                    );
                  if (prediction._tag === "Unpredictable")
                    return Check.notConfirmed(
                      `the solver found ${Symbolic.show(command)} on ${Symbolic.show(state)}, but the real code fails on it: ${Cause.pretty(prediction.cause)}`,
                    );
                  events = prediction.events as ReadonlyArray<{ readonly _tag: string }>;
                } else {
                  events = yield* attempt(`the rollup of ${source.written.name} threw`, () =>
                    (
                      source.cls.definition.rollup as unknown as (
                        state: unknown,
                        ctx: unknown,
                      ) => ReadonlyArray<{ readonly _tag: string }>
                    )(state, { id, version }),
                  );
                }
                const left = yield* attempt(`${written.name} threw`, () =>
                  events.flatMap((event, index) => {
                    const handler = handlers[event._tag];
                    const next = handler
                      ? handler(event, input, {
                          id,
                          stream: `${aggregate.aggregateName}/${String(id)}`,
                          seq: version + index + 1,
                          at: now ?? DateTime.makeUnsafe(0),
                          commandId: "prove",
                          correlationId: "prove",
                        })
                      : event;
                    return next === null ? [] : [next];
                  }),
                );
                const after = yield* attempt("evolve threw on the rewritten events", () =>
                  realFold(aggregate, other, left, id, version),
                );
                if (yield* attempt(`${what} threw`, () => holds(after)))
                  return Check.notConfirmed(
                    `the solver found a history ${written.name} would break ${what} on, but the real code keeps it`,
                  );
                // Two states the rules allow, not a history: whether the rewrite can
                // leave the second where the commands left the first is not known here.
                return Check.notConfirmed(
                  `on a recorded state ${Symbolic.show(state)} and a rewritten state ${Symbolic.show(other)}, ${
                    source._tag === "Command"
                      ? Symbolic.show(command)
                      : `the roll-up of ${source.written.name}`
                  } leaves ${left.length === 0 ? "nothing" : left.map(Symbolic.show).join(", ")} and the state ${Symbolic.show(after)}, which breaks ${what}. The proof does not know whether a history rewrites to that state: a sequence that does is looked for by Verify.model`,
                );
              });
          for (const check of yield* Paths.checks(interpreter, definition, ran.afterRewritten).pipe(
            Effect.catchTags({
              NotTranslated: (error) =>
                Effect.sync(() => {
                  const unread = Induction.notRead(error);
                  all(unread);
                  return [] as ReadonlyArray<Paths.Check>;
                }),
              Infeasible: () => Effect.succeed([] as ReadonlyArray<Paths.Check>),
              Rejected: () => Effect.succeed([] as ReadonlyArray<Paths.Check>),
            }),
          )) {
            if (!names.includes(check.name)) continue;
            const verdict: Verdict = Result.isFailure(check.condition)
              ? Induction.notRead(check.condition.failure)
              : yield* Check.checkAt(
                  solver,
                  run,
                  check.condition.success,
                  confirm(real[check.name]!, check.name),
                );
            verdicts.set(
              check.name,
              Induction.worse(verdicts.get(check.name)!, Induction.within(verdict, run)),
            );
          }
          const fitting = yield* Check.checkAt(
            solver,
            run,
            Symbolic.fits(ran.afterRewritten, stateAst, run),
            confirm(Schema.is(aggregate.definition.state), "the state's schema"),
          );
          fits = Induction.worse(fits, Induction.within(fitting, run));
        }),
    );
    rows.push({ step: nameOf(source), paths, fits, verdicts });
  }
  if (unchanged)
    for (const source of sources)
      rows.push({
        step: nameOf(source),
        paths: 0,
        fits: { _tag: "Proved" },
        verdicts: new Map(names.map((name) => [name, { _tag: "Proved" }])),
      });
  return {
    rows,
    /** The parts of the state the rewrite can leave other than they were. */
    differs: differs === "all" ? undefined : [...differs],
  };
});
