/**
 * Proves an aggregate's invariants: for every state the invariants allow and
 * every input a command accepts, the state after the command satisfies them
 * too. The prover reads the TypeScript of `decide`, `evolve` and the
 * invariants, and asks a solver whether any input breaks one.
 *
 * It needs `z3-solver` and `oxc-parser`, both optional peers, and runs under
 * Node.
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type { Verdict } from "./Prove/internal/Check.ts";
import * as Induction from "./Prove/internal/Induction.ts";
import * as Interpreter from "./Prove/internal/Interpreter.ts";
import * as Paths from "./Prove/internal/Paths.ts";
import * as Smt from "./Prove/internal/Smt.ts";
import * as Symbolic from "./Prove/internal/Symbolic.ts";
import * as Value from "./Prove/internal/Value.ts";

export type { Counterexample, Verdict } from "./Prove/internal/Check.ts";

export interface Options {
  /** The file the aggregate is declared in: `new URL("../src/Account.ts", import.meta.url)`, or a path. */
  readonly source: URL | string;
}

/** The prover could not start: a file did not load, or the solver is missing. */
export class ProveError extends Data.TaggedError("ProveError")<{ readonly message: string }> {}

/** At least one invariant is not proved. The message is the report. */
export class InvariantsNotProved extends Data.TaggedError("InvariantsNotProved")<{
  readonly message: string;
  readonly report: Report;
}> {}

export interface Report {
  readonly aggregate: string;
  /** Whether the aggregate's initial state is one its state's schema allows. */
  readonly initial: boolean;
  readonly commands: ReadonlyArray<{
    readonly command: string;
    /** The paths through the command that were checked. */
    readonly paths: number;
    /**
     * Whether every state the command leaves is one the state's schema allows.
     * Each proof starts from a state in the schema, so the proofs follow one
     * another only when every command keeps the state there.
     */
    readonly schema: Verdict;
    /**
     * Whether some state lets the command record an event. `false` when none
     * does: the command is proved to keep every invariant only because it
     * never does anything. `undefined` when the prover could not tell.
     */
    readonly accepted: boolean | undefined;
  }>;
  readonly invariants: ReadonlyArray<{
    readonly name: string;
    /** Whether the invariant holds on the aggregate's initial state. */
    readonly initial: boolean;
    readonly commands: ReadonlyArray<{
      readonly command: string;
      readonly verdict: Verdict;
      /** The paths through the command that were checked. */
      readonly paths: number;
    }>;
  }>;
  /** What the proof takes for granted. */
  readonly assumptions: ReadonlyArray<string>;
}

const ASSUMPTIONS = [
  "numbers are exact: integers stay within ±2^53",
  "an event or rejection whose fields fail its schema crashes the command, and nothing is committed",
  "of the state's schema, the prover reads types, integers and bounds: a check of another kind is not proved kept",
];

/**
 * Check every invariant of an aggregate against every command, and say what
 * was proved, what was broken, and what the prover could not read.
 *
 * **Example:** Printing the report
 * ```typescript
 * const report = yield* Prove.report(Account, {
 *   source: new URL("../src/Account/Account.aggregate.ts", import.meta.url),
 * });
 * console.log(Prove.render(report));
 * ```
 */
export const report = (
  aggregate: Aggregate.Any,
  options: Options,
): Effect.Effect<Report, ProveError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { loader, definition } = yield* Paths.load(aggregate, options.source);
    const names = Paths.invariantNames(definition);
    const real = (aggregate.definition.invariants ?? {}) as unknown as Record<
      string,
      (state: unknown) => boolean
    >;
    const solver = yield* Smt.solver;
    const interpreter = Interpreter.make(loader, new Value.Run([]));

    const rows = yield* Induction.rows(solver, interpreter, aggregate, definition);

    const initial = aggregate.definition.initial;
    const made: Report = {
      aggregate: aggregate.aggregateName,
      initial: Schema.is(aggregate.definition.state)(initial),
      commands: rows.map((row) => ({
        command: row.command,
        paths: row.paths,
        schema: row.fits,
        accepted: row.accepted,
      })),
      invariants: yield* Effect.forEach(names, (name) =>
        Effect.try({
          try: () => real[name]?.(initial) === true,
          catch: () => new ProveError({ message: `${name} threw on the initial state` }),
        }).pipe(
          Effect.map((holds) => ({
            name,
            initial: holds,
            commands: rows.map((row) => ({
              command: row.command,
              verdict: row.verdicts.get(name)!,
              paths: row.paths,
            })),
          })),
        ),
      ),
      assumptions: ASSUMPTIONS,
    };
    return made;
  }).pipe(
    Effect.scoped,
    Effect.catchTag(["LoadError", "SolverError"], (error) =>
      Effect.fail(new ProveError({ message: error.message })),
    ),
  );

/** Whether every command keeps the state in its schema: the proofs then follow one another. */
const closed = (report: Report): boolean =>
  report.initial && report.commands.every((c) => c.schema._tag === "Proved");

/**
 * Whether a report proves every invariant for every command: each command
 * keeps the state in its schema and keeps every invariant, and each can
 * record an event from some state.
 */
export const proved = (report: Report): boolean =>
  closed(report) &&
  report.commands.every((c) => c.accepted !== false) &&
  report.invariants.every(
    (invariant) =>
      invariant.initial && invariant.commands.every((c) => c.verdict._tag === "Proved"),
  );

/**
 * Prove every invariant of an aggregate, or fail with the report.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("the account's invariants hold", () =>
 *   Prove.invariants(Account, {
 *     source: new URL("../src/Account/Account.aggregate.ts", import.meta.url),
 *   }).pipe(Effect.provide(NodeServices.layer)),
 * );
 * ```
 */
export const invariants = (
  aggregate: Aggregate.Any,
  options: Options,
): Effect.Effect<Report, ProveError | InvariantsNotProved, FileSystem.FileSystem | Path.Path> =>
  report(aggregate, options).pipe(
    Effect.flatMap((made) =>
      proved(made)
        ? Effect.succeed(made)
        : Effect.fail(new InvariantsNotProved({ message: `\n${render(made)}`, report: made })),
    ),
  );

const detail = (verdict: Verdict): ReadonlyArray<string> => {
  switch (verdict._tag) {
    case "Proved":
      return [];
    case "Violated": {
      const c = verdict.counterexample;
      const rows: ReadonlyArray<readonly [string, string]> = [
        ["state", Symbolic.show(c.state)],
        ["command", Symbolic.show(c.command)],
        ...c.context.map((entry) => [entry.name, Symbolic.show(entry.value)] as const),
        ["now", DateTime.formatIso(c.now)],
        ["events", c.events.map(Symbolic.show).join(", ")],
        ["after", Symbolic.show(c.after)],
      ];
      const width = Math.max(...rows.map(([label]) => label.length));
      return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
    }
    case "NotTranslated":
      return [`${verdict.file}:${verdict.line}`, verdict.reason];
    default:
      return [verdict.reason];
  }
};

const LABEL = {
  Proved: "proved",
  Violated: "violated",
  Unconfirmed: "not proved",
  NotTranslated: "not read",
  Unknown: "not decided",
} as const;

/** A report as text, one invariant after another. */
export const render = (report: Report): string => {
  const lines: Array<string> = [
    `${report.aggregate}: ${report.invariants.length} invariants, ${report.commands.length} commands`,
    "",
  ];
  const section = (
    title: string,
    initial: boolean,
    commands: ReadonlyArray<{ readonly command: string; readonly verdict: Verdict }>,
    notes: ReadonlyArray<string>,
  ) => {
    const failed = commands.filter((c) => c.verdict._tag !== "Proved");
    const ok = initial && failed.length === 0 && notes.length === 0;
    lines.push(`${ok ? "✓" : "✗"} ${title}`);
    lines.push(`    ${initial ? "✓ holds" : "✗ does not hold"} on the initial state`);
    const passed = commands.filter((c) => c.verdict._tag === "Proved");
    if (passed.length > 0)
      lines.push(`    ✓ proved for ${passed.map((c) => c.command).join(", ")}`);
    for (const row of failed) {
      lines.push(`    ✗ ${row.command}: ${LABEL[row.verdict._tag]}`);
      for (const line of detail(row.verdict)) lines.push(`        ${line}`);
    }
    lines.push(...notes.map((note) => `    ✗ ${note}`), "");
  };
  const leaving = report.commands.filter((c) => c.schema._tag !== "Proved").map((c) => c.command);
  section(
    "The state stays in its schema",
    report.initial,
    report.commands.map((c) => ({ command: c.command, verdict: c.schema })),
    [],
  );
  // A proof starts from a state in the schema: it says nothing after a command that leaves it.
  const open = closed(report)
    ? []
    : [
        leaving.length > 0
          ? `proved only from a state in the schema, which ${leaving.join(", ")} may leave`
          : "proved only from a state in the schema, and the initial state is not in it",
      ];
  for (const invariant of report.invariants)
    section(invariant.name, invariant.initial, invariant.commands, open);
  for (const c of report.commands.filter((c) => c.accepted === false))
    lines.push(
      `✗ ${c.command} is never accepted: no state the invariants allow lets it record an event`,
      "",
    );
  lines.push("Assuming:", ...report.assumptions.map((a) => `  - ${a}`));
  return lines.join("\n");
};
