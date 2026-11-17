import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import type * as Decision from "../../Decision.ts";
import * as Decide from "./Decide.ts";
import type { DecisionStep, Inputs } from "./Paths.ts";
import * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import type { Run } from "./Value.ts";

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
  | { readonly _tag: "Unknown"; readonly reason: string };

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
export const solve = Effect.fn(function* (solver: Smt.Solver, run: Run, condition: string) {
  const applications = [...run.applications.values()];
  const declarations = [...run.declarations.values()];
  const base = [
    ...run.conditions,
    Smt.not(condition),
    // A number in JavaScript is exact only this far.
    ...declarations.flatMap((declaration) => {
      const match = /^\(declare-const (.+) Int\)$/.exec(declaration);
      return match && !run.bigs.has(match[1]!) ? [`(<= (- ${SAFE}) ${match[1]} ${SAFE})`] : [];
    }),
  ];
  // Equal results of a function that never repeats one mean equal arguments.
  for (const [index, a] of applications.entries())
    for (const b of applications.slice(index + 1))
      if (a.injective && b.injective && functionOf(a) === functionOf(b))
        base.push(`(=> (= ${a.term} ${b.term}) (= ${a.argument} ${b.argument}))`);
  const values = [...run.constants, ...applications.flatMap((a) => [a.term, a.argument])];
  const facts: Array<string> = [];

  const ask = Effect.fn(function* (extra: ReadonlyArray<string>) {
    const answer = yield* solver.check({
      declarations,
      assertions: [...base, ...facts, ...extra],
      values,
    });
    if (answer._tag !== "Sat") return answer;
    const model = new Map<string, number | bigint | string | boolean>();
    values.forEach((text, index) => {
      const value = answer.values[index];
      if (value !== undefined) model.set(text, value);
    });
    return { _tag: "Sat", model } as const;
  });

  /** What the real functions say at the arguments the model chose. */
  const real = (model: Model) =>
    applications.flatMap((application) => {
      const argument = model.get(application.argument);
      if (typeof argument !== "number") return [];
      const value = application.real(argument);
      const at = application.sort === "Real" ? Smt.real(argument) : Smt.int(argument);
      const point = `(= (${functionOf(application)} ${at.text}) ${Smt.string(value).text})`;
      return [
        { application, argument, value, point, agrees: model.get(application.term) === value },
      ];
    });

  for (let round = 0; round < 8; round++) {
    const answer = yield* ask([]);
    if (answer._tag !== "Sat") return answer;
    const points = real(answer.model);
    if (points.every((p) => p.agrees)) return answer;
    // Same arguments, with the functions' real values: often still a counterexample.
    const pinned = yield* ask(
      points.flatMap((p) => [
        `(= ${p.application.argument} ${(p.application.sort === "Real" ? Smt.real(p.argument) : Smt.int(p.argument)).text})`,
        p.point,
      ]),
    );
    if (pinned._tag === "Sat" && real(pinned.model).every((p) => p.agrees)) return pinned;
    facts.push(...points.map((p) => p.point));
  }
  return {
    _tag: "Unknown",
    reason: `every counterexample the solver found needs ${[...new Set(applications.map(functionOf))].join(", ")} to return something it does not`,
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
  const prediction = Aggregate.predict(aggregate, state, command, {
    now,
    version: (yield* build("version", inputs.version)) as number,
    commandId: (yield* build("commandId", inputs.commandId)) as string,
    context: context as Context.Context<never>,
  });
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
