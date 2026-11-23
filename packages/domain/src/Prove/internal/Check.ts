import * as BigDecimal from "effect/BigDecimal";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Rational from "effect/Rational";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import type * as Decision from "../../Decision.ts";
import * as Decide from "./Decide.ts";
import type { DecisionStep, Inputs } from "./Paths.ts";
import * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import type { Run, V } from "./Value.ts";

/** Inputs that break an invariant, and what the real code does with them. */
export interface Counterexample {
  readonly state: unknown;
  readonly command: unknown;
  /** What each request context the command read held. */
  readonly context: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
  readonly now: DateTime.Utc;
  readonly events: ReadonlyArray<unknown>;
  readonly after: unknown;
}

export type Verdict =
  /** No state and no input break the invariant. */
  | { readonly _tag: "Proved" }
  /** The real code breaks the invariant on these inputs. */
  | { readonly _tag: "Violated"; readonly counterexample: Counterexample }
  /** The solver found inputs, but the real code keeps the invariant on them. */
  | { readonly _tag: "Unconfirmed"; readonly reason: string }
  /** The prover met code it cannot read. */
  | {
      readonly _tag: "NotTranslated";
      readonly file: string;
      readonly line: number;
      readonly reason: string;
    }
  /** No list of up to a few items breaks it: longer lists were not looked at. */
  | { readonly _tag: "Bounded"; readonly reason: string }
  /** The solver gave up. */
  | { readonly _tag: "Unknown"; readonly reason: string }
  /** The prover read the code as doing one thing, and the real code does another on the same inputs. */
  | { readonly _tag: "Misread"; readonly reason: string };

export type Model = ReadonlyMap<string, number | bigint | string | boolean>;

const SAFE = Number.MAX_SAFE_INTEGER;

const unconfirmed = (reason: string): Verdict => ({ _tag: "Unconfirmed", reason });

/** The function symbol of an application `(f argument)`. */
const functionOf = (application: { readonly term: string; readonly argument: string }): string =>
  application.term.slice(1, application.term.length - application.argument.length - 2);

/**
 * Ask the solver for inputs on this path that make `condition` false: with an
 * invariant, inputs that break it; with `"false"`, any inputs that take the path. A function
 * the prover knows only by its implementation starts free; each answer that
 * disagrees with the real function is ruled out, and the question is asked again.
 */
export const solve = Effect.fn(function* (
  solver: Smt.Solver,
  run: Run,
  condition: string,
  /** Terms to read back with the inputs: the model then has each by its text. */
  reads: ReadonlyArray<Smt.Term> = [],
) {
  const applications = [...run.applications.values()];
  // What each tested result of an opaque function was called on: the real function is run on it.
  const tests = [...run.tests.values()].map((test) => {
    const terms = new Map<string, Smt.Term>();
    computed(test.applied, terms, run.lists);
    return { ...test, terms: [...terms.values()] };
  });
  const wanted = new Map<string, Smt.Term>(reads.map((term) => [term.text, term]));
  for (const test of tests)
    for (const term of test.terms)
      if (!run.declarations.has(term.text)) wanted.set(term.text, term);
  // What an opaque function is applied to may be a formula: it is read back by a name, as an output is.
  for (const application of applications)
    if (!run.declarations.has(application.argument))
      wanted.set(application.argument, { sort: application.sort, text: application.argument });
  const named = [...wanted.values()].map((term, index) => ({
    term,
    name: Smt.symbol(`$out.${index}`),
  }));
  const declarations = [...run.declarations.values()];
  const base = [
    ...run.conditions,
    Smt.not(condition),
    // A number in JavaScript is exact only this far.
    ...declarations.flatMap((declaration) => {
      const match = /^\(declare-const (.+) Int\)$/.exec(declaration);
      return match && !run.bigs.has(match[1]!) ? [`(<= (- ${SAFE}) ${match[1]} ${SAFE})`] : [];
    }),
    ...named.map((read) => `(= ${read.name} ${read.term.text})`),
  ];
  // Equal results of a function that never repeats one mean equal arguments.
  for (const [index, a] of applications.entries())
    for (const b of applications.slice(index + 1))
      if (a.injective && b.injective && functionOf(a) === functionOf(b))
        base.push(`(=> (= ${a.term} ${b.term}) (= ${a.argument} ${b.argument}))`);
  const values = [
    ...run.constants,
    ...applications.flatMap((a) =>
      run.declarations.has(a.argument) ? [a.term, a.argument] : [a.term],
    ),
    ...named.map((read) => read.name),
  ];
  const facts: Array<string> = [];

  const ask = Effect.fn(function* (extra: ReadonlyArray<string>) {
    const answer = yield* solver.check({
      declarations: [
        ...declarations,
        ...named.map((read) => `(declare-const ${read.name} ${read.term.sort})`),
      ],
      assertions: [...base, ...facts, ...extra],
      values,
    });
    if (answer._tag !== "Sat") return answer;
    const model = new Map<string, number | bigint | string | boolean>();
    const fractions = new Map<string, Smt.Fraction>();
    values.forEach((text, index) => {
      const value = answer.values[index];
      if (value !== undefined) model.set(text, value);
      const fraction = answer.fractions[index];
      if (fraction) fractions.set(text, fraction);
    });
    Smt.exact.set(model, fractions);
    // A term read back is known by its own text, as an input is.
    for (const read of named) {
      const value = model.get(read.name);
      if (value !== undefined) model.set(read.term.text, value);
      const fraction = fractions.get(read.name);
      if (fraction) fractions.set(read.term.text, fraction);
    }
    return { _tag: "Sat", model } as const;
  });

  /**
   * What the real functions say at the arguments the model chose. `pin` holds
   * the model to those arguments and the real result, and `fact` is what the
   * real function showed, true of every model.
   */
  const real = (
    model: Model,
  ): ReadonlyArray<{
    readonly agrees: boolean;
    readonly pin: ReadonlyArray<string>;
    readonly fact: string;
  }> => [
    ...applications.flatMap((application) => {
      const argument = model.get(application.argument);
      if (typeof argument !== "number") return [];
      const value = application.real(argument);
      const at = application.sort === "Real" ? Smt.real(argument) : Smt.int(argument);
      const point = `(= (${functionOf(application)} ${at.text}) ${Smt.string(value).text})`;
      return [
        {
          agrees: model.get(application.term) === value,
          pin: [`(= ${application.argument} ${at.text})`, point],
          fact: point,
        },
      ];
    }),
    // Whether an opaque function's result is truthy: the real function says, on these arguments.
    ...tests.flatMap((test) => {
      const built = Symbolic.concretize(test.applied, model, run.lists);
      if (!("value" in built)) return [];
      const observed = test.read(built.value);
      // The result is not of the kind the code took it for: the real code is what says so.
      if (observed === undefined) return [];
      const truthy = literalOf(test.term.sort, observed);
      const at = test.terms.flatMap((term) => {
        const value = model.get(term.text);
        return value === undefined ? [] : [`(= ${term.text} ${literalOf(term.sort, value)})`];
      });
      if (at.length < test.terms.length) return [];
      const result = `(= ${test.term.text} ${truthy})`;
      return [
        {
          agrees: model.get(test.term.text) === observed,
          pin: [...at, result],
          fact:
            at.length === 0
              ? result
              : `(=> ${at.length === 1 ? at[0]! : `(and ${at.join(" ")})`} ${result})`,
        },
      ];
    }),
  ];

  for (let round = 0; round < 8; round++) {
    const answer = yield* ask([]);
    if (answer._tag !== "Sat") return answer;
    const points = real(answer.model);
    if (points.every((p) => p.agrees)) return answer;
    // Same arguments, with the functions' real values: often still a counterexample.
    const pinned = yield* ask(points.flatMap((p) => p.pin));
    if (pinned._tag === "Sat" && real(pinned.model).every((p) => p.agrees)) return pinned;
    facts.push(...points.map((p) => p.fact));
  }
  return {
    _tag: "Unknown",
    reason: `every counterexample the solver found needs ${[
      ...new Set([
        ...applications.map(functionOf),
        ...tests.map((test) => (test.applied._tag === "Applied" ? test.applied.name : "")),
      ]),
    ].join(", ")} to return something it does not`,
  } as const;
});

const attempt = <A>(what: string, evaluate: () => A): Effect.Effect<A, Verdict> =>
  Effect.try({ try: evaluate, catch: (cause) => unconfirmed(`${what}: ${String(cause)}`) });

/** One step the real code took: a command on a state, and what it left. */
export interface Moved {
  readonly before: unknown;
  readonly after: unknown;
  readonly command: unknown;
  readonly events: ReadonlyArray<unknown>;
  /** The request contexts the command ran with. */
  readonly context: Context.Context<never>;
}

/** Something a command must keep true of the step it takes. */
export interface Kept {
  /** How a sentence names it: an invariant's name, or `the state's schema`. */
  readonly what: string;
  readonly holds: (moved: Moved) => boolean;
  /** What a counterexample shows as the states before and after, in place of the instance's own. */
  readonly shown?: (moved: Moved) => { readonly state: unknown; readonly after: unknown };
}

/** The solver's value for part of a path, as a real value: it fails when it has none. */
export type Build = (
  what: string,
  value: Parameters<typeof Symbolic.concretize>[0],
) => Effect.Effect<unknown, Verdict>;

/**
 * Something to keep, or how to make it from a counterexample: a rule about
 * more than the step's own instances builds the others from the solver's
 * answer, and fails when they are not ones the real code allows.
 */
export type Keeping<K> = K | ((build: Build) => Effect.Effect<K, Verdict>);

const keeping = <K>(given: Keeping<K>, build: Build): Effect.Effect<K, Verdict> =>
  typeof given === "function"
    ? (given as (build: Build) => Effect.Effect<K, Verdict>)(build)
    : Effect.succeed(given);

/** A verdict that the solver's answer is not one the real code confirms. */
export const notConfirmed = unconfirmed;

/**
 * Every invariant and transition of an aggregate, by name, on a step the real
 * code took. An invariant looks at the state the step left.
 */
export const rules = (aggregate: Aggregate.Any): Readonly<Record<string, Kept["holds"]>> => {
  const invariants = (aggregate.definition.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
  const transitions = (aggregate.definition.transitions ?? {}) as unknown as Record<
    string,
    (step: Omit<Moved, "context">) => boolean | Effect.Effect<boolean, never, never>
  >;
  return {
    ...Object.fromEntries(
      Object.entries(invariants).map(([name, holds]) => [
        name,
        (moved: Moved) => holds(moved.after),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(transitions).map(([name, holds]) => [
        name,
        (moved: Moved) => {
          const { context, ...step } = moved;
          const made = holds(step);
          return Effect.isEffect(made) ? Effect.runSync(Effect.provide(made, context)) : made;
        },
      ]),
    ),
  };
};

/** The invariant or transition of an aggregate with this name, as something a command must keep. */
export const invariant = (aggregate: Aggregate.Any, name: string): Kept => ({
  what: name,
  holds: (moved) => rules(aggregate)[name]!(moved),
});

/** That the state is one the aggregate's schema allows, as something a command must keep. */
export const schema = (aggregate: Aggregate.Any): Kept => ({
  what: "the state's schema",
  holds: (moved) => Schema.is(aggregate.definition.state)(moved.after),
});

/** Build the counterexample as real values, and run the real `decide`, `evolve` and check on it. */
const replay = Effect.fn(function* (
  aggregate: Aggregate.Any,
  given: Keeping<Kept>,
  run: Run,
  inputs: Inputs,
  model: Model,
) {
  const build = (what: string, value: Parameters<typeof Symbolic.concretize>[0]) => {
    const built = Symbolic.concretize(value, model, run.lists);
    return "value" in built
      ? Effect.succeed(built.value)
      : Effect.fail(unconfirmed(`the solver found inputs, but ${built.reason} (${what})`));
  };
  const definition = aggregate.definition;
  const invariants = (definition.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
  const kept = yield* keeping(given, build);
  const state = yield* build("state", inputs.state);
  if (!Schema.is(definition.state)(state))
    return yield* Effect.fail(
      unconfirmed(
        `the solver's state ${Symbolic.show(state)} is not one the state's schema allows`,
      ),
    );
  for (const [name, holds] of Object.entries(invariants)) {
    if (!(yield* attempt(`${name} threw on the solver's state`, () => holds(state))))
      return yield* Effect.fail(
        unconfirmed(
          `the solver's state ${Symbolic.show(state)} already breaks ${name}, which the prover could not read`,
        ),
      );
  }
  const { _tag: tag, ...fields } = (yield* build("command", inputs.command)) as {
    readonly _tag: string;
  };
  const cls = definition.commands.find((c) => c.tag === tag) as unknown as new (fields: object) => {
    readonly _tag: string;
  };
  const command = yield* attempt(
    `${tag} refuses the solver's input ${Symbolic.show(fields)}`,
    () => new cls(fields),
  );
  let context = Context.empty() as Context.Context<unknown>;
  const read: Array<{ name: string; value: unknown }> = [];
  for (const [key, entry] of run.contexts) {
    const value = yield* build(key, entry.value);
    context = Context.add(context, entry.tag as Context.Key<unknown, unknown>, value);
    read.push({ name: key.slice(key.lastIndexOf("/") + 1), value });
  }
  const now = (yield* build("now", inputs.now)) as DateTime.Utc;
  const version = (yield* build("version", inputs.version)) as number;
  const commandId = (yield* build("commandId", inputs.commandId)) as string;
  const prediction = yield* attempt(`${tag} threw`, () =>
    Aggregate.predict(aggregate, state, command, {
      now,
      version,
      commandId,
      context: context as Context.Context<never>,
    }),
  );
  if (prediction._tag === "Rejected")
    return unconfirmed(
      `the solver found ${Symbolic.show(command)} on ${Symbolic.show(state)}, but the real code rejects it with ${Symbolic.show(prediction.rejection)}`,
    );
  if (prediction._tag === "Unpredictable")
    return unconfirmed(
      `the solver found ${Symbolic.show(command)} on ${Symbolic.show(state)}, but the real code fails on it: ${Cause.pretty(prediction.cause)}`,
    );
  const moved: Moved = {
    before: state,
    after: prediction.state,
    command,
    events: prediction.events,
    context: context as Context.Context<never>,
  };
  const holds = yield* attempt(`${kept.what} threw`, () => kept.holds(moved));
  if (holds)
    return unconfirmed(
      `the solver found ${Symbolic.show(command)} on ${Symbolic.show(state)}, but the real code keeps ${kept.what} on it`,
    );
  const verdict: Verdict = {
    _tag: "Violated",
    counterexample: {
      state,
      command,
      context: read,
      now,
      events: prediction.events,
      after: prediction.state,
      ...kept.shown?.(moved),
    },
  };
  return verdict;
});

/** A value as text two values share only when they are the same data. */
const canon = (value: unknown): string => {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  if (DateTime.isDateTime(value)) return `@${DateTime.toEpochMillis(value)}`;
  if (Duration.isDuration(value)) return `~${Duration.toMillis(value)}`;
  if (Option.isOption(value)) return Option.isSome(value) ? `some(${canon(value.value)})` : "none";
  if (Result.isResult(value))
    return Result.isSuccess(value) ? `ok(${canon(value.success)})` : `err(${canon(value.failure)})`;
  if (BigDecimal.isBigDecimal(value))
    return `#${value.pipe(BigDecimal.normalize, BigDecimal.format)}`;
  if (Rational.isRational(value)) return `%${Rational.format(value)}`;
  if (Redacted.isRedacted(value)) return `hidden(${value.pipe(Redacted.value, canon)})`;
  // A hash set and a hash map are what they hold, in whatever order.
  if (HashSet.isHashSet(value)) return `set(${[...value].map(canon).sort().join(",")})`;
  if (HashMap.isHashMap(value))
    return `map(${[...value]
      .map(([key, held]) => `${canon(key)}=>${canon(held)}`)
      .sort()
      .join(",")})`;
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, field]) => `${key}:${canon(field)}`)
    .join(",")}}`;
};

/** Whether a real event or rejection has every field the prover read, with the same value. */
const carries = (real: unknown, read: unknown): boolean =>
  typeof real === "object" &&
  real !== null &&
  typeof read === "object" &&
  read !== null &&
  Object.entries(read).every(
    ([key, field]) =>
      field === undefined || canon((real as Record<string, unknown>)[key]) === canon(field),
  );

/** Every term a value is made of that is not an input: what the solver has to work out. */
const computed = (
  value: V,
  into: Map<string, Smt.Term>,
  /** What the path chose for each field the code read. */
  lists?: ReadonlyMap<string, V>,
): void => {
  switch (value._tag) {
    case "Pending": {
      const chosen = lists?.get(`?${value.name}`);
      if (chosen) computed(chosen, into, lists);
      return;
    }
    case "Term":
      into.set(value.term.text, value.term);
      return;
    case "Time":
      into.set(value.millis.text, value.millis);
      return;
    case "Obj":
      for (const field of Object.values(value.fields)) computed(field, into, lists);
      return;
    case "Arr":
      for (const item of value.items) computed(item, into, lists);
      return;
    case "Applied":
      for (const argument of value.args) computed(argument, into, lists);
      return;
    default:
      return;
  }
};

/** A value the solver found, as the solver writes it. */
const literalOf = (sort: Smt.Sort, value: number | bigint | string | boolean): string =>
  typeof value === "string"
    ? Smt.string(value).text
    : typeof value === "boolean"
      ? Smt.bool(value).text
      : typeof value === "bigint"
        ? Smt.big(value).text
        : sort === "Real"
          ? Smt.real(value).text
          : Smt.int(value).text;

/** What comparing a path with the real code gave. */
export type Agreement =
  | { readonly _tag: "Agreed" }
  /**
   * Nothing was compared. No inputs take the path, or with `taken`, the ones
   * the solver found cannot be built as real values or run.
   */
  | { readonly _tag: "Skipped"; readonly taken: boolean }
  | { readonly _tag: "Differs"; readonly reason: string };

/** What the prover read a command to do on one path. */
export type Read =
  | { readonly _tag: "Rejected"; readonly rejection: V }
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Changed"; readonly events: ReadonlyArray<V>; readonly after: V };

/**
 * Pick inputs that take one path, run the real `decide` and `evolve` on them,
 * and say whether they do what the prover read: the same rejection, or the
 * same events and the same state. A proof is about what the prover read, so
 * it stands only where the two agree.
 */
export const agree = Effect.fn(function* (
  solver: Smt.Solver,
  aggregate: Aggregate.Any,
  run: Run,
  inputs: Inputs,
  read: Read,
) {
  const skipped: Agreement = { _tag: "Skipped", taken: true };
  const outputs = new Map<string, Smt.Term>();
  if (read._tag === "Rejected") computed(read.rejection, outputs, run.lists);
  if (read._tag === "Changed") {
    computed(read.after, outputs, run.lists);
    for (const event of read.events) computed(event, outputs, run.lists);
  }
  const answer = yield* solve(
    solver,
    run,
    "false",
    [...outputs.values()].filter((term) => !run.declarations.has(term.text)),
  );
  if (answer._tag !== "Sat") return { _tag: "Skipped", taken: false } as const;
  const model = answer.model;
  const build = (value: V) => {
    const built = Symbolic.concretize(value, model, run.lists);
    return "value" in built ? Effect.succeed(built.value) : Effect.fail(skipped);
  };
  /**
   * Whether the real hash sets and hash maps give their items in the order
   * this path read them in. Where one does not, the real code took another
   * path, which the prover read too.
   */
  const ordered = Effect.gen(function* () {
    for (const order of run.orders) {
      const read: Array<unknown> = [];
      for (const item of order.items) read.push(yield* build(item));
      const real =
        order.kind === "HashSet"
          ? [...HashSet.fromIterable(read)]
          : [...HashMap.fromIterable(read as ReadonlyArray<readonly [unknown, unknown]>)];
      if (real.length !== read.length || real.some((item, i) => canon(item) !== canon(read[i])))
        return false;
    }
    return true;
  });
  const tried = Effect.gen(function* () {
    const definition = aggregate.definition;
    const state = yield* build(inputs.state);
    if (!Schema.is(definition.state)(state)) return skipped;
    const invariants = (definition.invariants ?? {}) as unknown as Record<
      string,
      (state: unknown) => boolean
    >;
    // A state an invariant the prover could not read refuses is not one a proof starts from.
    for (const holds of Object.values(invariants))
      if (!(yield* Effect.try(() => holds(state)).pipe(Effect.orElseSucceed(() => false))))
        return skipped;
    const { _tag: tag, ...fields } = (yield* build(inputs.command)) as { readonly _tag: string };
    const cls = definition.commands.find((c) => c.tag === tag) as unknown as new (
      fields: object,
    ) => { readonly _tag: string };
    const command = yield* Effect.try(() => new cls(fields)).pipe(Effect.mapError(() => skipped));
    let context = Context.empty() as Context.Context<unknown>;
    for (const entry of run.contexts.values())
      context = Context.add(
        context,
        entry.tag as Context.Key<unknown, unknown>,
        yield* build(entry.value),
      );
    const now = (yield* build(inputs.now)) as DateTime.Utc;
    const version = (yield* build(inputs.version)) as number;
    const commandId = (yield* build(inputs.commandId)) as string;
    // Real code that throws where the prover read none of that is a difference, not a crash.
    const prediction = yield* Effect.try({
      try: () =>
        Aggregate.predict(aggregate, state, command, {
          now,
          version,
          commandId,
          context: context as Context.Context<never>,
        }),
      catch: (cause): Agreement => ({
        _tag: "Differs",
        reason: `the prover read ${Symbolic.show(command)} on ${Symbolic.show(state)}, and the real code threw: ${String(cause)}`,
      }),
    });
    // A command that fails is one whose fields a schema the prover does not read refuses.
    if (prediction._tag === "Unpredictable") return skipped;
    const on = `${Symbolic.show(command)} on ${Symbolic.show(state)}`;
    const did =
      prediction._tag === "Rejected"
        ? `rejects it with ${Symbolic.show(prediction.rejection)}`
        : prediction.events.length === 0
          ? "records nothing"
          : `records ${prediction.events.map(Symbolic.show).join(", ")} and leaves ${Symbolic.show(prediction.state)}`;
    const differs = (what: string): Agreement => ({
      _tag: "Differs",
      reason: `the prover read ${on} as ${what}, and the real code ${did}`,
    });
    if (read._tag === "Rejected") {
      const rejection = yield* build(read.rejection);
      return prediction._tag === "Rejected" && carries(prediction.rejection, rejection)
        ? ({ _tag: "Agreed" } as const)
        : differs(`rejected with ${Symbolic.show(rejection)}`);
    }
    if (read._tag === "Unchanged")
      return prediction._tag === "Accepted" && prediction.events.length === 0
        ? ({ _tag: "Agreed" } as const)
        : differs("recording nothing");
    const events: Array<unknown> = [];
    for (const event of read.events) events.push(yield* build(event));
    const after = yield* build(read.after);
    return prediction._tag === "Accepted" &&
      prediction.events.length === events.length &&
      prediction.events.every((event, index) => carries(event, events[index])) &&
      canon(prediction.state) === canon(after)
      ? ({ _tag: "Agreed" } as const)
      : differs(
          `recording ${events.map(Symbolic.show).join(", ")} and leaving ${Symbolic.show(after)}`,
        );
  });
  const agreement = yield* tried.pipe(Effect.catch((agreement) => Effect.succeed(agreement)));
  if (agreement._tag !== "Differs") return agreement;
  return (yield* ordered.pipe(Effect.orElseSucceed(() => true))) ? agreement : skipped;
});

/**
 * Whether an invariant, or the state's schema, can be false at the end of one
 * path. A counterexample counts only when the real code, run on it, breaks it
 * too.
 */
export const check = (
  solver: Smt.Solver,
  aggregate: Aggregate.Any,
  kept: Keeping<Kept>,
  run: Run,
  inputs: Inputs,
  condition: string,
): Effect.Effect<Verdict, Smt.SolverError> =>
  judged(solver, run, condition, (model) => replay(aggregate, kept, run, inputs, model));

/** Whether `condition` can be false on a path: a counterexample counts only when `replay` confirms it. */
const judged = (
  solver: Smt.Solver,
  run: Run,
  condition: string,
  replay: (model: Model) => Effect.Effect<Verdict, Verdict>,
): Effect.Effect<Verdict, Smt.SolverError> =>
  condition === "true"
    ? Effect.succeed<Verdict>({ _tag: "Proved" })
    : solve(solver, run, condition).pipe(
        Effect.flatMap((answer): Effect.Effect<Verdict> =>
          answer._tag === "Unsat"
            ? Effect.succeed({ _tag: "Proved" })
            : answer._tag === "Unknown"
              ? Effect.succeed({ _tag: "Unknown", reason: answer.reason })
              : replay(answer.model).pipe(Effect.catch((verdict) => Effect.succeed(verdict))),
        ),
      );

/**
 * Whether `condition` can be false on a path where no command runs. `confirm`
 * builds the solver's answer as real values and says what the real code makes of it.
 */
export const checkAt = (
  solver: Smt.Solver,
  run: Run,
  condition: string,
  confirm: (build: Build) => Effect.Effect<Verdict, Verdict>,
): Effect.Effect<Verdict, Smt.SolverError> =>
  judged(solver, run, condition, (model) =>
    confirm((what, value) => {
      const built = Symbolic.concretize(value, model, run.lists);
      return "value" in built
        ? Effect.succeed(built.value)
        : Effect.fail(unconfirmed(`the solver found inputs, but ${built.reason} (${what})`));
    }),
  );

/** One step the real code of a decision took: what it left of every instance it read. */
export interface DecisionMoved {
  readonly ran: Decide.Ran & { readonly _tag: "Accepted" };
  /** The stream of each instance the prover gave a state, in the order it read them. */
  readonly streams: ReadonlyArray<string>;
  readonly command: unknown;
  readonly context: Context.Context<never>;
}

/** Something a decision must keep true of the step it takes. */
export interface DecisionKept {
  readonly what: string;
  readonly holds: (moved: DecisionMoved) => boolean;
  /** What a counterexample shows as the states before and after, in place of the ones the decision read. */
  readonly shown?: (moved: DecisionMoved) => { readonly state: unknown; readonly after: unknown };
}

/** An aggregate's invariant or transition, on the instance a decision read at this place. */
export const onInstance = (aggregate: Aggregate.Any, name: string, slot: number): DecisionKept => ({
  what: `${aggregate.aggregateName}.${name}`,
  holds: (moved) => {
    const wrote = moved.ran.wrote.find((wrote) => wrote.stream === moved.streams[slot]);
    return (
      !wrote ||
      wrote.events.length === 0 ||
      rules(aggregate)[name]!({
        before: wrote.before,
        after: wrote.after,
        command: moved.command,
        events: wrote.events,
        context: moved.context,
      })
    );
  },
});

/** That every instance a decision read is left in its state's schema. */
export const schemas: DecisionKept = {
  what: "the states' schemas",
  holds: (moved) =>
    moved.ran.wrote.every((wrote) => Schema.is(wrote.aggregate.definition.state)(wrote.after)),
};

/** One of a decision's own transitions, on the step it took. */
export const transition = (decision: Decision.Any, name: string): DecisionKept => ({
  what: name,
  holds: (moved) => {
    const holds = decision.definition.transitions?.[name];
    if (!holds) return true;
    const wrote = new Map(moved.ran.wrote.map((wrote) => [wrote.stream, wrote]));
    const made = holds({
      before: Decide.byName(moved.ran.streams, (stream) => wrote.get(stream)?.before),
      after: Decide.byName(moved.ran.streams, (stream) => wrote.get(stream)?.after),
      command: moved.command,
      events: moved.ran.events,
    });
    return (
      (Effect.isEffect(made)
        ? made.pipe(
            Effect.provideContext(moved.context as Context.Context<unknown>),
            Effect.runSync,
          )
        : made) === true
    );
  },
});

/** Build a decision's counterexample as real values, and run the real `decide` and `evolve` on it. */
const replayDecision = Effect.fn(function* (
  decision: Decision.Any,
  /** The aggregate of each instance read, in the order the step read them. */
  aggregates: ReadonlyArray<Aggregate.Any>,
  given: Keeping<DecisionKept>,
  run: Run,
  step: DecisionStep,
  model: Model,
) {
  const build = (what: string, value: Parameters<typeof Symbolic.concretize>[0]) => {
    const built = Symbolic.concretize(value, model, run.lists);
    return "value" in built
      ? Effect.succeed(built.value)
      : Effect.fail(unconfirmed(`the solver found inputs, but ${built.reason} (${what})`));
  };
  const kept = yield* keeping(given, build);
  const states = new Map<string, { readonly state: unknown; readonly version: number }>();
  const streams: Array<string> = [];
  for (const [index, slot] of step.slots.entries()) {
    const aggregate = aggregates[index]!;
    const state = yield* build("state", slot.state);
    if (!Schema.is(aggregate.definition.state)(state))
      return yield* Effect.fail(
        unconfirmed(
          `the solver's state ${Symbolic.show(state)} is not one the schema of ${aggregate.aggregateName} allows`,
        ),
      );
    const invariants = (aggregate.definition.invariants ?? {}) as unknown as Record<
      string,
      (state: unknown) => boolean
    >;
    for (const [name, holds] of Object.entries(invariants)) {
      if (!(yield* attempt(`${name} threw on the solver's state`, () => holds(state))))
        return yield* Effect.fail(
          unconfirmed(
            `the solver's state ${Symbolic.show(state)} already breaks ${aggregate.aggregateName}.${name}, which the prover could not read`,
          ),
        );
    }
    const stream = `${aggregate.aggregateName}/${String(yield* build("id", slot.id))}`;
    if (states.has(stream))
      return yield* Effect.fail(unconfirmed(`the solver gave two instances the one id ${stream}`));
    states.set(stream, { state, version: (yield* build("version", slot.version)) as number });
    streams.push(stream);
  }
  const { _tag: tag, ...fields } = (yield* build("command", step.inputs.command)) as {
    readonly _tag: string;
  };
  const cls = decision.command as unknown as new (fields: object) => { readonly _tag: string };
  const command = yield* attempt(
    `${tag} refuses the solver's input ${Symbolic.show(fields)}`,
    () => new cls(fields),
  );
  let context = Context.empty() as Context.Context<unknown>;
  const read: Array<{ name: string; value: unknown }> = [];
  for (const [key, entry] of run.contexts) {
    const value = yield* build(key, entry.value);
    context = Context.add(context, entry.tag as Context.Key<unknown, unknown>, value);
    read.push({ name: key.slice(key.lastIndexOf("/") + 1), value });
  }
  const now = (yield* build("now", step.inputs.now)) as DateTime.Utc;
  const commandId = (yield* build("commandId", step.inputs.commandId)) as string;
  const ran = yield* attempt(`${tag} threw`, () =>
    Decide.run(decision, command, states, {
      now,
      commandId,
      context: context as Context.Context<never>,
    }),
  );
  const before = () =>
    Symbolic.show(Decide.byName(ranStreams(ran, step, streams), (s) => states.get(s)?.state));
  if (ran._tag === "Rejected")
    return unconfirmed(
      `the solver found ${Symbolic.show(command)} on ${before()}, but the real code rejects it with ${Symbolic.show(ran.rejection)}`,
    );
  if (ran._tag === "Unpredictable")
    return unconfirmed(
      `the solver found ${Symbolic.show(command)} on ${before()}, but the real code fails on it: ${Cause.pretty(ran.cause)}`,
    );
  const moved: DecisionMoved = {
    ran,
    streams,
    command,
    context: context as Context.Context<never>,
  };
  const holds = yield* attempt(`${kept.what} threw`, () => kept.holds(moved));
  if (holds)
    return unconfirmed(
      `the solver found ${Symbolic.show(command)} on ${before()}, but the real code keeps ${kept.what} on it`,
    );
  const wrote = new Map(ran.wrote.map((wrote) => [wrote.stream, wrote]));
  const verdict: Verdict = {
    _tag: "Violated",
    counterexample: {
      state: Decide.byName(ran.streams, (stream) => wrote.get(stream)?.before),
      command,
      context: read,
      now,
      events: ran.events,
      after: Decide.byName(ran.streams, (stream) => wrote.get(stream)?.after),
      ...kept.shown?.(moved),
    },
  };
  return verdict;
});

/** The streams each name in `reads` stands for: the real ones, or as the prover read them. */
const ranStreams = (
  ran: Decide.Ran,
  step: DecisionStep,
  streams: ReadonlyArray<string>,
): Readonly<Record<string, string | ReadonlyArray<string>>> =>
  ran._tag === "Accepted"
    ? ran.streams
    : Object.fromEntries(
        Object.entries(step.names).map(([name, index]) => [
          name,
          typeof index === "number" ? streams[index]! : index.map((at) => streams[at]!),
        ]),
      );

/**
 * Whether something a decision must keep can be false at the end of one path.
 * A counterexample counts only when the real `decide` and `evolve`, run on
 * it, break it too.
 */
export const checkDecision = (
  solver: Smt.Solver,
  decision: Decision.Any,
  aggregates: ReadonlyArray<Aggregate.Any>,
  kept: Keeping<DecisionKept>,
  run: Run,
  step: DecisionStep,
  condition: string,
): Effect.Effect<Verdict, Smt.SolverError> =>
  judged(solver, run, condition, (model) =>
    replayDecision(decision, aggregates, kept, run, step, model),
  );
