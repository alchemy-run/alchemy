import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as SchemaAST from "effect/SchemaAST";
import type * as Aggregate from "../../Aggregate.ts";
import * as Check from "./Check.ts";
import type { Interpreter } from "./Interpreter.ts";
import * as Paths from "./Paths.ts";
import * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import * as Value from "./Value.ts";

type V = Value.V;

/**
 * A rule that might be true of every state an aggregate reaches: as the code
 * to write, as a function of a real state, and as a formula of a state the
 * prover holds. The formula is `undefined` where the prover has no number
 * for a field.
 */
interface Candidate {
  /** What a rule made of it is called: `ReservedWithinBalance`. */
  readonly name: string;
  /** The code, with `$s` where the state is named. */
  readonly text: string;
  readonly holds: (state: unknown) => boolean;
  readonly formula: (state: V) => string | undefined;
}

/** The most whole-number fields of one shape of a state that rules are guessed over. */
const MAX_FIELDS = 6;

/** The most paths through an aggregate's commands a suggestion is looked for on. */
const MAX_PATHS = 256;

/** The whole-number fields of an object a schema describes. */
const numbers = (ast: SchemaAST.Objects): ReadonlyArray<string> =>
  ast.propertySignatures
    .filter((property) => property.type._tag === "Number")
    .map((property) => String(property.name))
    .slice(0, MAX_FIELDS);

/** The tag a member of a union is told apart by, where it has one. */
const tagOf = (ast: SchemaAST.Objects): string | undefined => {
  const tag = ast.propertySignatures.find((property) => String(property.name) === "_tag")?.type;
  return tag?._tag === "Literal" && typeof tag.literal === "string" ? tag.literal : undefined;
};

/** A field of a state the prover holds, as a whole number in the solver's words. */
const whole = (state: V, field: string): string | undefined => {
  const value = state._tag === "Obj" ? state.fields[field] : undefined;
  if (value?._tag === "Num")
    return Number.isInteger(value.value) ? Smt.int(value.value).text : undefined;
  return value?._tag === "Term" && value.term.sort === "Int" && value.big !== true
    ? value.term.text
    : undefined;
};

const capital = (name: string): string => name.slice(0, 1).toUpperCase() + name.slice(1);

/** An invariant to add, as its name and the code to write. */
export interface Suggestion {
  readonly name: string;
  readonly source: string;
}

const numberOf = (state: unknown, field: string): number | undefined => {
  const value = (state as Readonly<Record<string, unknown>> | null)?.[field];
  return typeof value === "number" ? value : undefined;
};

/**
 * The rules guessed for a state's schema: that a whole number is not below
 * zero, and that one is not above another. A state that is a union of tagged
 * shapes gets each rule once for each shape.
 */
const candidatesOf = (ast: SchemaAST.AST): ReadonlyArray<Candidate> => {
  const shapes: ReadonlyArray<{ readonly ast: SchemaAST.Objects; readonly tag?: string }> =
    ast._tag === "Objects"
      ? [{ ast }]
      : ast._tag === "Union"
        ? ast.types.flatMap((member) => {
            const tag = member._tag === "Objects" ? tagOf(member) : undefined;
            return member._tag === "Objects" && tag !== undefined ? [{ ast: member, tag }] : [];
          })
        : [];
  const made: Array<Candidate> = [];
  for (const shape of shapes) {
    const fields = numbers(shape.ast);
    const guarded = (
      name: string,
      text: string,
      holds: (state: unknown) => boolean | undefined,
      formula: (state: V) => string | undefined,
    ): Candidate => ({
      name: `${shape.tag ?? ""}${name}`,
      text: shape.tag === undefined ? text : `$s._tag !== ${JSON.stringify(shape.tag)} || ${text}`,
      holds: (state) =>
        (shape.tag !== undefined && (state as { readonly _tag?: unknown })._tag !== shape.tag) ||
        holds(state) === true,
      formula: (state) => {
        if (shape.tag === undefined) return formula(state);
        const tag = state._tag === "Obj" ? state.fields._tag : undefined;
        if (tag?._tag !== "Str") return undefined;
        return tag.value === shape.tag ? formula(state) : "true";
      },
    });
    for (const field of fields)
      made.push(
        guarded(
          `${capital(field)}NeverNegative`,
          `$s.${field} >= 0`,
          (state) => {
            const value = numberOf(state, field);
            return value !== undefined && value >= 0;
          },
          (state) => {
            const value = whole(state, field);
            return value === undefined ? undefined : `(>= ${value} 0)`;
          },
        ),
      );
    for (const low of fields)
      for (const high of fields) {
        if (low === high) continue;
        made.push(
          guarded(
            `${capital(low)}Within${capital(high)}`,
            `$s.${low} <= $s.${high}`,
            (state) => {
              const a = numberOf(state, low);
              const b = numberOf(state, high);
              return a !== undefined && b !== undefined && a <= b;
            },
            (state) => {
              const a = whole(state, low);
              const b = whole(state, high);
              return a === undefined || b === undefined ? undefined : `(<= ${a} ${b})`;
            },
          ),
        );
      }
  }
  return made;
};

/** What one look at every path of every command says of the rules still standing. */
type Pass =
  /** The prover could not read a path: nothing can be suggested. */
  | { readonly _tag: "Unread" }
  | {
      readonly _tag: "Looked";
      /** The rules a command does not keep. */
      readonly dropped: ReadonlySet<Candidate>;
      /** Whether every command keeps the rule asked about, from a state the others allow. */
      readonly proved: boolean;
    };

/**
 * Take every command from any state the aggregate's invariants and the
 * `standing` rules allow, and say which of those rules a command does not
 * keep, and whether every command keeps `target`.
 */
const pass = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  ast: SchemaAST.AST,
  target: string,
  standing: ReadonlyArray<Candidate>,
) {
  const dropped = new Set<Candidate>();
  let proved = true;
  let paths = 0;
  for (const cls of aggregate.definition.commands) {
    const command = cls as unknown as Paths.CommandClass;
    let prefix: ReadonlyArray<number> | undefined = [];
    while (prefix) {
      if (++paths > MAX_PATHS) return { _tag: "Unread" } as const;
      const run = new Value.Run(prefix);
      interpreter.current.run = run;
      const taken = yield* Effect.gen(function* () {
        const state = Symbolic.symbolic(ast, "state", run);
        for (const check of yield* Paths.checks(interpreter, definition, state).pipe(
          Effect.catchTag("NotTranslated", () => Effect.succeed<ReadonlyArray<Paths.Check>>([])),
        )) {
          if (Result.isFailure(check.condition)) continue;
          if (check.condition.success === "false") return yield* new Value.Infeasible();
          run.assume(check.condition.success);
        }
        for (const candidate of standing) {
          if (dropped.has(candidate)) continue;
          const formula = candidate.formula(state);
          if (formula === undefined) dropped.add(candidate);
          else if (formula === "false") return yield* new Value.Infeasible();
          else run.assume(formula);
        }
        const version = run.constant("version", "Int");
        run.assume(`(>= ${version.text} 0)`);
        const stepped = yield* Paths.step(
          interpreter,
          definition,
          command,
          state,
          { _tag: "Term", term: version },
          "",
        );
        if (stepped.applied._tag !== "Changed") return undefined;
        return {
          after: stepped.applied.state,
          checks: yield* Paths.checks(interpreter, definition, stepped.applied.state, {
            before: state,
            command: stepped.inputs.command,
            events: stepped.applied.events,
          }),
        };
      }).pipe(
        Effect.map((made) => ({ _tag: "Ran", made }) as const),
        Effect.catchTags({
          Infeasible: () => Effect.succeed({ _tag: "Ran", made: undefined } as const),
          Rejected: () => Effect.succeed({ _tag: "Ran", made: undefined } as const),
          NotTranslated: () => Effect.succeed({ _tag: "Unread" } as const),
        }),
      );
      prefix = Value.nextPrefix(run.taken);
      // A list given only a few items says nothing of a longer one.
      if (taken._tag === "Unread" || run.bounds.size > 0) return { _tag: "Unread" } as const;
      if (!taken.made) continue;
      for (const candidate of standing) {
        if (dropped.has(candidate)) continue;
        const formula = candidate.formula(taken.made.after);
        if (formula === "true") continue;
        if (formula === undefined || (yield* Check.solve(solver, run, formula))._tag !== "Unsat")
          dropped.add(candidate);
      }
      const check = taken.made.checks.find((check) => check.name === target);
      if (!check || Result.isFailure(check.condition)) return { _tag: "Unread" } as const;
      if (
        proved &&
        check.condition.success !== "true" &&
        (yield* Check.solve(solver, run, check.condition.success))._tag !== "Unsat"
      )
        proved = false;
    }
  }
  const made: Pass = { _tag: "Looked", dropped, proved };
  return made;
});

/**
 * The rules among `from` that every command keeps, taking them all to hold
 * before it: a rule one command breaks is taken out, and the rest are looked
 * at again without it. Says too whether they make `target` one every command
 * keeps.
 */
const kept = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  ast: SchemaAST.AST,
  target: string,
  from: ReadonlyArray<Candidate>,
) {
  let standing = from;
  while (true) {
    const looked = yield* pass(solver, interpreter, aggregate, definition, ast, target, standing);
    if (looked._tag === "Unread") return undefined;
    if (looked.dropped.size === 0) return { standing, proved: looked.proved };
    standing = standing.filter((candidate) => !looked.dropped.has(candidate));
  }
});

/**
 * An invariant that makes `target` provable, where a simple one does: a rule
 * that is true of a new instance, that every command keeps, and that rules
 * out the states the proof of `target` fails from. It is the fewest of the
 * guessed rules that do, written as one invariant.
 *
 * A proof starts from any state the invariants allow. One that is true of
 * every state the aggregate reaches can still fail, from a state no sequence
 * of commands leads to. The fix is an invariant that says so, and this finds
 * it where it is about whole numbers not going below zero or above one
 * another.
 */
export const suggest = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  target: string,
) {
  const ast = Symbolic.typeOf(definition.state);
  if (!ast) return undefined;
  const initial = aggregate.definition.initial;
  const guessed = candidatesOf(ast).filter((candidate) => candidate.holds(initial));
  if (guessed.length === 0) return undefined;
  const all = yield* kept(solver, interpreter, aggregate, definition, ast, target, guessed);
  if (!all || !all.proved || all.standing.length === 0) return undefined;
  // Leave out each rule the proof does not need.
  let needed = all.standing;
  for (const candidate of all.standing) {
    if (!needed.includes(candidate)) continue;
    const without = yield* kept(
      solver,
      interpreter,
      aggregate,
      definition,
      ast,
      target,
      needed.filter((other) => other !== candidate),
    );
    if (without?.proved) needed = without.standing;
  }
  if (needed.length === 0) return undefined;
  const parts = needed.map((candidate) =>
    needed.length > 1 && candidate.text.includes("||") ? `(${candidate.text})` : candidate.text,
  );
  // The state is named as the rule it is suggested for names it.
  const written = Paths.ruleNode(definition, target);
  const given = written?.params?.[0];
  const state =
    given?.type === "Identifier" && typeof given.name === "string" ? given.name : "state";
  const made: Suggestion = {
    name: needed.map((candidate) => candidate.name).join("And"),
    source: `(${state}) => ${parts.join(" && ").replaceAll("$s", state)}`,
  };
  return made;
});
