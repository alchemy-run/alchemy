import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import type { Inputs } from "./Paths.ts";
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
  /** The solver gave up. */
  | { readonly _tag: "Unknown"; readonly reason: string };

export type Model = ReadonlyMap<string, number | string | boolean>;

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
      return match ? [`(<= (- ${SAFE}) ${match[1]} ${SAFE})`] : [];
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
    const model = new Map<string, number | string | boolean>();
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
      const point = `(= (${functionOf(application)} ${Smt.int(argument).text}) ${Smt.string(value).text})`;
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
      points.flatMap((p) => [`(= ${p.application.argument} ${Smt.int(p.argument).text})`, p.point]),
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

/** Build the counterexample as real values, and run the real `decide`, `evolve` and invariant on it. */
const replay = Effect.fn(function* (
  aggregate: Aggregate.Any,
  invariant: string,
  run: Run,
  inputs: Inputs,
  model: Model,
) {
  const build = (what: string, value: Parameters<typeof Symbolic.concretize>[0]) => {
    const built = Symbolic.concretize(value, model);
    return "value" in built
      ? Effect.succeed(built.value)
      : Effect.fail(unconfirmed(`the solver found inputs, but ${built.reason} (${what})`));
  };
  const definition = aggregate.definition;
  const invariants = (definition.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
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
    id: (yield* build("id", inputs.id)) as string,
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
  const holds = yield* attempt(`${invariant} threw`, () =>
    invariants[invariant]!(prediction.state),
  );
  if (holds)
    return unconfirmed(
      `the solver found ${Symbolic.show(command)} on ${Symbolic.show(state)}, but the real code keeps ${invariant} on it`,
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
    },
  };
  return verdict;
});

/**
 * Whether an invariant can be false at the end of one path. A counterexample
 * counts only when the real code, run on it, breaks the invariant too.
 */
export const check = (
  solver: Smt.Solver,
  aggregate: Aggregate.Any,
  invariant: string,
  run: Run,
  inputs: Inputs,
  condition: string,
): Effect.Effect<Verdict, Smt.SolverError> =>
  condition === "true"
    ? Effect.succeed<Verdict>({ _tag: "Proved" })
    : solve(solver, run, condition).pipe(
        Effect.flatMap((answer): Effect.Effect<Verdict> =>
          answer._tag === "Unsat"
            ? Effect.succeed({ _tag: "Proved" })
            : answer._tag === "Unknown"
              ? Effect.succeed({ _tag: "Unknown", reason: answer.reason })
              : replay(aggregate, invariant, run, inputs, answer.model).pipe(
                  Effect.catch((verdict) => Effect.succeed(verdict)),
                ),
        ),
      );
