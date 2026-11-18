/**
 * Proves an aggregate's invariants: for every state the invariants allow and
 * every input a command accepts, the state after the command satisfies them
 * too. The prover reads the TypeScript of `decide`, `evolve` and the
 * invariants, and asks a solver whether any input breaks one.
 *
 * It uses `z3-solver` and `oxc-parser`, which are loaded only when it runs, and runs under
 * Node.
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type * as Decision from "./Decision.ts";
import type { Verdict } from "./Prove/internal/Check.ts";
import * as Induction from "./Prove/internal/Induction.ts";
import * as Interpreter from "./Prove/internal/Interpreter.ts";
import * as Paths from "./Prove/internal/Paths.ts";
import * as Smt from "./Prove/internal/Smt.ts";
import * as Source from "./Prove/internal/Source.ts";
import * as Symbolic from "./Prove/internal/Symbolic.ts";
import * as Value from "./Prove/internal/Value.ts";

export type { Counterexample, Verdict } from "./Prove/internal/Check.ts";

export interface Options {
  /** The file the aggregate is declared in: `new URL("../src/Account.ts", import.meta.url)`, or a path. */
  readonly source: URL | string;
  /**
   * The decisions that record on the aggregate, each with the file it is
   * declared in. An aggregate that folds an event none of its own commands
   * records is proved only with the decision that records it.
   */
  readonly decisions?: ReadonlyArray<{
    readonly decision: Decision.Any;
    readonly source: URL | string;
  }>;
}

/** Where a decision is declared. */
export interface DecisionOptions {
  /** The file the decision is declared in: `new URL("../src/Transfer.decision.ts", import.meta.url)`, or a path. */
  readonly source: URL | string;
}

/** At least one rule a decision must keep is not proved. The message is the report. */
export class DecisionNotProved extends Data.TaggedError("DecisionNotProved")<{
  readonly message: string;
  readonly report: DecisionReport;
}> {}

export interface DecisionReport {
  /** The tag of the command the decision implements. */
  readonly decision: string;
  /** The aggregates it reads, each under the name `decide` reads it by. */
  readonly reads: ReadonlyArray<{ readonly name: string; readonly aggregate: string }>;
  /** The paths through the decision that were checked. */
  readonly paths: number;
  /** Whether every state the decision leaves is one its aggregate's schema allows. */
  readonly schema: Verdict;
  /**
   * Whether some states let the decision record an event. `false` when none
   * does, `undefined` when the prover could not tell.
   */
  readonly accepted: boolean | undefined;
  /**
   * Every rule the decision must keep: the invariants and transitions of the
   * aggregates it reads, named `Account.NeverOverdrawn`, then its own
   * transitions.
   */
  readonly rules: ReadonlyArray<{
    readonly name: string;
    readonly kind: "invariant" | "transition" | "decision";
    readonly verdict: Verdict;
  }>;
  /** The checks of the schemas the prover does not read. */
  readonly unread: ReadonlyArray<string>;
  /** What the decision writes to a part of a state whose schema has a check the prover does not read. */
  readonly unkept: ReadonlyArray<string>;
  /** What the proof takes for granted. */
  readonly assumptions: ReadonlyArray<string>;
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
  /** The aggregate's transitions: what each command may do in one step. */
  readonly transitions: ReadonlyArray<{
    readonly name: string;
    readonly commands: ReadonlyArray<{
      readonly command: string;
      readonly verdict: Verdict;
      /** The paths through the command that were checked. */
      readonly paths: number;
    }>;
  }>;
  /**
   * The checks of the state's and the commands' schemas the prover does not
   * read, each with the part it is on. A value such a check refuses may be
   * tried, so a counterexample that needs one is not confirmed.
   */
  readonly unread: ReadonlyArray<string>;
  /**
   * What a command writes to a part of the state whose schema has a check
   * the prover does not read: the new value is not proved to pass it.
   */
  readonly unkept: ReadonlyArray<string>;
  /**
   * The events the aggregate folds that none of its commands records, and no
   * decision given in `decisions` does: a decision records them, and nothing
   * here says what it does to the invariants.
   */
  readonly outside: ReadonlyArray<string>;
  /** What the proof takes for granted. */
  readonly assumptions: ReadonlyArray<string>;
}

/** What a decision's proof takes for granted of the platform that commits it. */
export const ATOMIC =
  "a decision's events commit on every instance it recorded on, or on none: how a platform commits them is not checked";

const ASSUMPTIONS = [
  "whole numbers are exact: a number stays within ±2^53, and a bigint has no limit",
  "an event or rejection whose fields fail its schema crashes the command, and nothing is committed",
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

    const own = yield* Induction.rows(solver, interpreter, aggregate, definition);
    // Each decision that records on the aggregate is one more command its rules must survive.
    const recorded = new Set<string>(
      aggregate.definition.commands.flatMap((command) => command.events.map((event) => event.tag)),
    );
    const rows: Array<Induction.Row> = [...own];
    for (const given of options.decisions ?? []) {
      loader.adopt(given.decision);
      const impl = yield* decisionAt(loader, interpreter, given.decision, given.source);
      const row = yield* Induction.decisionRow(solver, interpreter, impl);
      for (const event of given.decision.command.events) recorded.add(event.tag);
      rows.push({
        ...row,
        verdicts: new Map(
          Paths.ruleNames(definition).map((name) => [
            name,
            row.verdicts.get(Induction.ruleOf(aggregate.aggregateName, name)) ?? {
              _tag: "Proved",
            },
          ]),
        ),
      });
    }

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
      transitions: Paths.transitionNames(definition).map((name) => ({
        name,
        commands: rows.map((row) => ({
          command: row.command,
          verdict: row.verdicts.get(name)!,
          paths: row.paths,
        })),
      })),
      unread: [
        ...Symbolic.unread(aggregate.definition.state, "state"),
        ...aggregate.definition.commands.flatMap((command) =>
          Object.entries((command as unknown as Paths.CommandClass).fields).flatMap(
            ([key, schema]) => Symbolic.unread(schema, `${command.tag}.${key}`),
          ),
        ),
      ].map((check) => `${check.at}: ${check.check}`),
      unkept: Induction.unkept(rows),
      outside: aggregate.definition.events
        .map((event) => event.tag)
        .filter((tag) => !recorded.has(tag)),
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
  report.outside.length === 0 &&
  report.commands.every((c) => c.accepted !== false) &&
  report.invariants.every(
    (invariant) =>
      invariant.initial && invariant.commands.every((c) => c.verdict._tag === "Proved"),
  ) &&
  report.transitions.every((transition) =>
    transition.commands.every((c) => c.verdict._tag === "Proved"),
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
  Bounded: "proved for short lists only",
  Violated: "violated",
  Unconfirmed: "not proved",
  NotTranslated: "not read",
  Unknown: "not decided",
} as const;

/** A report as text, one invariant after another. */
export const render = (report: Report): string => {
  const lines: Array<string> = [
    `${report.aggregate}: ${report.invariants.length} invariants, ${
      report.transitions.length > 0 ? `${report.transitions.length} transitions, ` : ""
    }${report.commands.length} commands`,
    "",
  ];
  const section = (
    title: string,
    /** `undefined` for a transition: it is about a step, and a new instance has taken none. */
    initial: boolean | undefined,
    commands: ReadonlyArray<{ readonly command: string; readonly verdict: Verdict }>,
    notes: ReadonlyArray<string>,
  ) => {
    const failed = commands.filter((c) => c.verdict._tag !== "Proved");
    const ok = initial !== false && failed.length === 0 && notes.length === 0;
    lines.push(`${ok ? "✓" : "✗"} ${title}`);
    if (initial !== undefined)
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
  // A command proved for short lists only is not known to leave the schema: its own line says so.
  const leaving = report.commands
    .filter((c) => c.schema._tag !== "Proved" && c.schema._tag !== "Bounded")
    .map((c) => c.command);
  section(
    "The state stays in its schema",
    report.initial,
    report.commands.map((c) => ({ command: c.command, verdict: c.schema })),
    [],
  );
  // A proof starts from a state in the schema: it says nothing after a command that leaves it.
  const open =
    leaving.length > 0
      ? [`proved only from a state in the schema, which ${leaving.join(", ")} may leave`]
      : report.initial
        ? []
        : ["proved only from a state in the schema, and the initial state is not in it"];
  for (const invariant of report.invariants)
    section(invariant.name, invariant.initial, invariant.commands, open);
  for (const transition of report.transitions)
    section(transition.name, undefined, transition.commands, open);
  for (const c of report.commands.filter((c) => c.accepted === false))
    lines.push(
      `✗ ${c.command} is never accepted: no state the invariants allow lets it record an event`,
      "",
    );
  if (report.outside.length > 0)
    lines.push(
      `✗ ${report.aggregate} folds ${report.outside.join(", ")}, which none of its commands records: a decision does`,
      "    pass that decision in `decisions`, or verify the model that hosts both",
      "",
    );
  lines.push(...notes(report));
  return lines.join("\n");
};

/** The schema checks a report could not read or prove kept, then what it takes for granted. */
const notes = (report: {
  readonly unread: ReadonlyArray<string>;
  readonly unkept: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  ...(report.unread.length > 0
    ? [
        "Schema checks not read: a value one refuses may be tried",
        ...report.unread.map((check) => `  - ${check}`),
        "",
      ]
    : []),
  ...(report.unkept.length > 0
    ? ["Schema checks not proved kept", ...report.unkept.map((line) => `  - ${line}`), ""]
    : []),
  "Assuming:",
  ...report.assumptions.map((a) => `  - ${a}`),
];

/** A decision's definition and the aggregates' it reads, from the file that declares it. */
const decisionAt = Effect.fn(function* (
  loader: Source.Loader,
  interpreter: Interpreter.Interpreter,
  decision: Decision.Any,
  source: URL | string,
) {
  const path = yield* Path.Path;
  const file =
    typeof source === "string"
      ? path.resolve(source)
      : yield* path
          .fromFileUrl(source)
          .pipe(
            Effect.mapError(
              (error) => new Source.LoadError({ file: String(source), message: error.message }),
            ),
          );
  const modules = yield* Paths.reach(loader, file);
  const impl = yield* Induction.locate(interpreter, modules, decision);
  if (typeof impl === "string")
    return yield* new Source.LoadError({
      file,
      message: `${file} does not declare ${impl}, or import the file that does`,
    });
  return impl;
});

/**
 * Check a decision against every rule it must keep, and say what was proved,
 * what was broken, and what the prover could not read. The rules are the
 * invariants and transitions of each aggregate it reads, on the instance it
 * recorded on, and its own transitions, on all of them together.
 *
 * **Example:** Printing the report
 * ```typescript
 * const report = yield* Prove.decisionReport(Transfer, {
 *   source: new URL("../src/Transfer/Transfer.decision.ts", import.meta.url),
 * });
 * console.log(Prove.renderDecision(report));
 * ```
 */
export const decisionReport = (
  decision: Decision.Any,
  options: DecisionOptions,
): Effect.Effect<DecisionReport, ProveError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const loader = yield* Source.loader;
    loader.adopt(decision);
    const solver = yield* Smt.solver;
    const interpreter = Interpreter.make(loader, new Value.Run([]));
    const impl = yield* decisionAt(loader, interpreter, decision, options.source);
    const row = yield* Induction.decisionRow(solver, interpreter, impl);
    const aggregates = [...new Set(Object.values(impl.reads))].filter(
      (read, index, all) => all.findIndex((other) => other.cls === read.cls) === index,
    );
    const made: DecisionReport = {
      decision: decision.decisionName,
      reads: Object.entries(impl.reads).map(([name, read]) => ({
        name,
        aggregate: read.cls.aggregateName,
      })),
      paths: row.paths,
      schema: row.fits,
      accepted: row.accepted,
      rules: [
        ...aggregates.flatMap((read) => [
          ...Paths.invariantNames(read.definition).map((name) => ({
            name: Induction.ruleOf(read.cls.aggregateName, name),
            kind: "invariant" as const,
          })),
          ...Paths.transitionNames(read.definition).map((name) => ({
            name: Induction.ruleOf(read.cls.aggregateName, name),
            kind: "transition" as const,
          })),
        ]),
        ...row.own.map((name) => ({ name, kind: "decision" as const })),
      ].map((rule) => ({ ...rule, verdict: row.verdicts.get(rule.name)! })),
      unread: [
        ...aggregates.flatMap((read) =>
          Symbolic.unread(read.cls.definition.state, `${read.cls.aggregateName} state`),
        ),
        ...Object.entries(impl.command.fields).flatMap(([key, schema]) =>
          Symbolic.unread(schema, `${impl.command.tag}.${key}`),
        ),
      ].map((check) => `${check.at}: ${check.check}`),
      unkept: Induction.unkept([row]),
      assumptions: [...ASSUMPTIONS, ATOMIC],
    };
    return made;
  }).pipe(
    Effect.scoped,
    Effect.catchTag(["LoadError", "SolverError"], (error) =>
      Effect.fail(new ProveError({ message: error.message })),
    ),
  );

/**
 * Whether a report proves a decision: it keeps every state in its schema,
 * keeps every rule, and can record an event from some states.
 */
export const decisionProved = (report: DecisionReport): boolean =>
  report.schema._tag === "Proved" &&
  report.accepted !== false &&
  report.rules.every((rule) => rule.verdict._tag === "Proved");

/**
 * Prove that a decision keeps every rule of the aggregates it reads, and its
 * own, or fail with the report.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("a transfer keeps both accounts' rules", () =>
 *   Prove.decision(Transfer, {
 *     source: new URL("../src/Transfer/Transfer.decision.ts", import.meta.url),
 *   }).pipe(Effect.provide(NodeServices.layer)),
 * );
 * ```
 */
export const decision = (
  decision: Decision.Any,
  options: DecisionOptions,
): Effect.Effect<
  DecisionReport,
  ProveError | DecisionNotProved,
  FileSystem.FileSystem | Path.Path
> =>
  decisionReport(decision, options).pipe(
    Effect.flatMap((made) =>
      decisionProved(made)
        ? Effect.succeed(made)
        : Effect.fail(
            new DecisionNotProved({ message: `\n${renderDecision(made)}`, report: made }),
          ),
    ),
  );

/** A decision's report as text, one rule after another. */
export const renderDecision = (report: DecisionReport): string => {
  const lines: Array<string> = [
    `${report.decision}: reads ${report.reads.map((read) => `${read.name} (${read.aggregate})`).join(", ")}; ${report.rules.length} rules, ${report.paths} paths`,
    "",
  ];
  const line = (title: string, verdict: Verdict) => {
    lines.push(
      `${verdict._tag === "Proved" ? "✓" : "✗"} ${title}${verdict._tag === "Proved" ? "" : `: ${LABEL[verdict._tag]}`}`,
    );
    for (const text of detail(verdict)) lines.push(`    ${text}`);
  };
  line("Every state stays in its schema", report.schema);
  for (const rule of report.rules) line(rule.name, rule.verdict);
  if (report.accepted === false)
    lines.push(
      `✗ ${report.decision} is never accepted: no states the invariants allow let it record an event`,
    );
  lines.push("", ...notes(report));
  return lines.join("\n");
};
