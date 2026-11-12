import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Aggregate from "../../Aggregate.ts";
import type { Verdict } from "./Check.ts";
import * as Check from "./Check.ts";
import type { Interpreter } from "./Interpreter.ts";
import * as Paths from "./Paths.ts";
import type * as Smt from "./Smt.ts";
import * as Value from "./Value.ts";

/** What one command does to every invariant, from any state the schema allows. */
export interface Row {
  readonly command: string;
  /** The paths through the command that were checked. */
  readonly paths: number;
  readonly verdicts: ReadonlyMap<string, Verdict>;
  /**
   * Whether every state the command leaves is one the state's schema allows.
   * The proofs assume it of the state a command meets, so they follow one
   * another only when every command keeps it.
   */
  readonly fits: Verdict;
  /**
   * Whether some state the invariants allow lets the command record an event:
   * `false` when none does, so the proofs say nothing about it, and
   * `undefined` when the prover could not tell.
   */
  readonly accepted: boolean | undefined;
}

/** Whether every command keeps the state in its schema, so that the proofs follow one another. */
export const closed = (rows: ReadonlyArray<Row>): boolean =>
  rows.every((row) => row.fits._tag === "Proved");

const RANK = { Proved: 0, Unknown: 1, NotTranslated: 2, Unconfirmed: 3, Violated: 4 } as const;

const worse = (a: Verdict, b: Verdict): Verdict => (RANK[b._tag] > RANK[a._tag] ? b : a);

const notRead = (error: Value.NotTranslated): Verdict => ({
  _tag: "NotTranslated",
  file: error.file,
  line: error.line,
  reason: error.reason,
});

const MAX_PATHS = 4096;

/**
 * Take each command from any state that satisfies every invariant, along
 * every path through its code, and say whether each invariant still holds.
 */
export const rows = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
) {
  const names = Paths.invariantNames(definition);
  const made: Array<Row> = [];
  for (const cls of aggregate.definition.commands) {
    const command = cls as unknown as Paths.CommandClass;
    const verdicts = new Map<string, Verdict>(names.map((name) => [name, { _tag: "Proved" }]));
    const all = (verdict: Verdict) => {
      for (const name of names) verdicts.set(name, worse(verdicts.get(name)!, verdict));
    };
    let fits: Verdict = { _tag: "Proved" };
    let accepted: boolean | undefined = false;
    let paths = 0;
    let prefix: ReadonlyArray<number> | undefined = [];
    while (prefix) {
      if (++paths > MAX_PATHS) {
        const many: Verdict = {
          _tag: "Unknown",
          reason: `${command.tag} has more than ${MAX_PATHS} paths`,
        };
        all(many);
        fits = worse(fits, many);
        accepted ||= undefined;
        break;
      }
      const taken = yield* Paths.path(interpreter, definition, command, prefix);
      prefix = Value.nextPrefix(taken.run.taken);
      const outcome = taken.outcome;
      if (outcome._tag === "Stopped") {
        const unread = notRead(outcome.error);
        all(unread);
        fits = worse(fits, unread);
        accepted ||= undefined;
      }
      if (outcome._tag !== "Changed" || !taken.inputs) continue;
      for (const check of outcome.checks) {
        const verdict: Verdict = Result.isFailure(check.condition)
          ? notRead(check.condition.failure)
          : yield* Check.check(
              solver,
              aggregate,
              Check.invariant(aggregate, check.name),
              taken.run,
              taken.inputs,
              check.condition.success,
            );
        verdicts.set(check.name, worse(verdicts.get(check.name)!, verdict));
      }
      fits = worse(
        fits,
        yield* Check.check(
          solver,
          aggregate,
          Check.schema(aggregate),
          taken.run,
          taken.inputs,
          outcome.fits,
        ),
      );
      if (accepted !== true) {
        // Any inputs at all that take this path: the command can record an event.
        const taking = yield* Check.solve(solver, taken.run, "false");
        accepted = taking._tag === "Sat" ? true : taking._tag === "Unknown" ? undefined : accepted;
      }
    }
    made.push({ command: command.tag, paths, verdicts, fits, accepted });
  }
  return made;
});
