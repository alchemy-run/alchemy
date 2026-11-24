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
import type * as Compaction from "./Compaction.ts";
import type * as Decision from "./Decision.ts";
import type { Verdict } from "./Prove/internal/Check.ts";
import * as History from "./Prove/internal/History.ts";
import * as Induction from "./Prove/internal/Induction.ts";
import * as Interpreter from "./Prove/internal/Interpreter.ts";
import * as Paths from "./Prove/internal/Paths.ts";
import * as Smt from "./Prove/internal/Smt.ts";
import * as Source from "./Prove/internal/Source.ts";
import * as Suggest from "./Prove/internal/Suggest.ts";
import * as Symbolic from "./Prove/internal/Symbolic.ts";
import * as Value from "./Prove/internal/Value.ts";
import type * as Rewrite from "./Rewrite.ts";

export type { Counterexample, Verdict } from "./Prove/internal/Check.ts";
export type { Suggestion } from "./Prove/internal/Suggest.ts";
export type { Reading } from "./Prove/internal/Source.ts";

export interface Options extends Source.Reading {
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
  /**
   * Look for an invariant to add where a proof fails from a state the rules
   * allow.
   * @default true
   */
  readonly suggest?: boolean;
}

/** Where a decision is declared. */
export interface DecisionOptions extends Source.Reading {
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
    /**
     * Where the proof fails from a state the rules allow: an invariant that
     * rules that state out and that every command keeps. With it written
     * down, this one is proved. `undefined` where no simple one does.
     */
    readonly suggested: Suggest.Suggestion | undefined;
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
    /** An invariant that makes it proved, as for an invariant. */
    readonly suggested: Suggest.Suggestion | undefined;
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
  /**
   * How far the prover's reading was held against the real code: on inputs
   * picked for each path through a command, the real `decide` and `evolve`
   * were run. `differs` names each path where they did something else.
   */
  readonly agreement: {
    /** The paths inputs were picked and run for. */
    readonly compared: number;
    /** The paths inputs take that could not be run on the real code. */
    readonly uncompared: number;
    readonly differs: ReadonlyArray<string>;
  };
  /** What the proof takes for granted. */
  readonly assumptions: ReadonlyArray<string>;
}

/** What a decision's proof takes for granted of the platform that commits it. */
export const ATOMIC =
  "a decision's events commit on every instance it recorded on, or on none: how a platform commits them is not checked";

const ASSUMPTIONS = [
  "whole numbers are exact: a number stays within ±2^53, and a bigint has no limit",
  "a duration an input holds is a whole number of milliseconds",
  "an event or rejection whose fields fail its schema crashes the command, and nothing is committed",
];

/** What a proof takes for granted of the functions the prover did not read. */
export const pure = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.length === 0
    ? []
    : [
        `${names.join(", ")} ${names.length === 1 ? "is" : "are each"} a pure function: the same result for the same arguments, nothing changed, and a result its place in a state or an event allows`,
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
    const { loader, definition } = yield* Paths.load(aggregate, options.source, options);
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
    // A proof that fails on a real step, from a state the rules allow: the state
    // may be one no sequence reaches, and an invariant that says so is looked for.
    const suggested = new Map<string, Suggest.Suggestion | undefined>();
    if (options.suggest !== false && (options.decisions ?? []).length === 0)
      for (const name of Paths.ruleNames(definition))
        if (
          rows.some((row) => row.verdicts.get(name)?._tag === "Violated") &&
          rows.every((row) => row.verdicts.get(name)?._tag !== "Misread")
        )
          suggested.set(
            name,
            yield* Suggest.suggest(solver, interpreter, aggregate, definition, name),
          );
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
            suggested: suggested.get(name),
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
        suggested: suggested.get(name),
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
      agreement: {
        compared: own.reduce((sum, row) => sum + row.compared, 0),
        uncompared: own.reduce((sum, row) => sum + row.uncompared, 0),
        differs: own.flatMap((row) => row.differs),
      },
      assumptions: [...ASSUMPTIONS, ...pure(loader.opaques())],
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
        ...(c.now === undefined ? [] : [["now", DateTime.formatIso(c.now)] as const]),
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
  NotTranslated: "not supported",
  Unknown: "not decided",
  Misread: "read wrongly",
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
    suggested?: Suggest.Suggestion,
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
    lines.push(...notes.map((note) => `    ✗ ${note}`));
    if (suggested) lines.push(...suggestion(suggested, "    "));
    lines.push("");
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
    section(invariant.name, invariant.initial, invariant.commands, open, invariant.suggested);
  for (const transition of report.transitions)
    section(transition.name, undefined, transition.commands, open, transition.suggested);
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
  lines.push(agreed(report.agreement), "", ...notes(report));
  return lines.join("\n");
};

/** An invariant to add, as lines of a report. */
export const suggestion = (
  suggested: Suggest.Suggestion,
  indent: string,
): ReadonlyArray<string> => [
  `${indent}Every command keeps this, and with it the rule is proved. Add it to the invariants:`,
  `${indent}  ${suggested.name}: ${suggested.source},`,
];

/** How far a report's reading was held against the real code, as a line. */
export const agreed = (agreement: {
  readonly compared: number;
  readonly uncompared: number;
  readonly differs: ReadonlyArray<string>;
}): string =>
  agreement.differs.length > 0
    ? `✗ The real code does something else on ${agreement.differs.length} of the ${agreement.compared} paths compared`
    : `Agreed with the real code: inputs picked for each of ${agreement.compared} paths through the commands did what the prover read${
        agreement.uncompared > 0
          ? ` (${agreement.uncompared} more could not be run: the prover cannot build their inputs)`
          : ""
      }`;

/** The schema checks a report could not read or prove kept, then what it takes for granted. */
const notes = (report: {
  readonly unread: ReadonlyArray<string>;
  readonly unkept: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  ...(report.unread.length > 0
    ? [
        "Schema checks not supported: a value one refuses may be tried",
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
    const loader = yield* Source.loader(options);
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
      assumptions: [...ASSUMPTIONS, ATOMIC, ...pure(loader.opaques())],
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

/** Where a compaction is declared. */
export interface CompactionOptions extends Source.Reading {
  /** The file the compaction is declared in: `new URL("../src/BringForward.compaction.ts", import.meta.url)`, or a path. */
  readonly source: URL | string;
}

/** A roll-up is not proved to lose nothing. The message is the report. */
export class CompactionNotProved extends Data.TaggedError("CompactionNotProved")<{
  readonly message: string;
  readonly report: CompactionReport;
}> {}

export interface CompactionReport {
  readonly compaction: string;
  /** The aggregate whose instances it compacts. */
  readonly aggregate: string;
  /** The paths through the roll-up that were checked. */
  readonly paths: number;
  /**
   * Whether folding the roll-up from `initial` gives the state back, for
   * every state the aggregate's rules allow: what a view or an instance read
   * after the compaction is built from.
   */
  readonly lossless: Verdict;
  /** Whether folding the roll-up onto the state it was made from leaves that state. */
  readonly standing: Verdict;
  /** The checks of the state's schema the prover does not read. */
  readonly unread: ReadonlyArray<string>;
  /** What the proof takes for granted. */
  readonly assumptions: ReadonlyArray<string>;
}

/** The file a source names, as a path. */
const fileOf = Effect.fn(function* (source: URL | string) {
  const path = yield* Path.Path;
  return typeof source === "string"
    ? path.resolve(source)
    : yield* path
        .fromFileUrl(source)
        .pipe(
          Effect.mapError(
            (error) => new Source.LoadError({ file: String(source), message: error.message }),
          ),
        );
});

/** An aggregate's definition among the files one file reaches. */
const aggregateAt = Effect.fn(function* (
  modules: ReadonlyArray<Value.Module>,
  aggregate: Aggregate.Any,
  file: string,
) {
  const definition = Paths.aggregateIn(modules, aggregate);
  if (!definition)
    return yield* new Source.LoadError({
      file,
      message: `${file} does not import the file that declares ${aggregate.aggregateName}`,
    });
  const missed = Paths.unread(definition, aggregate.definition);
  if (missed.length > 0)
    return yield* new Source.LoadError({
      file,
      message: `${aggregate.aggregateName} is declared without its invariants ${missed.join(", ")}: each must be written in its definition, as a property, under a name of its own`,
    });
  return definition;
});

/**
 * Check that a compaction's roll-up loses nothing, for every state its
 * aggregate's rules allow, and say what was proved and what was not. An
 * instance refuses a roll-up that would change its own state when it runs;
 * this says so before any instance meets one.
 *
 * **Example:** Printing the report
 * ```typescript
 * const report = yield* Prove.compactionReport(BringForward, {
 *   source: new URL("../src/Wallet/BringForward.compaction.ts", import.meta.url),
 * });
 * console.log(Prove.renderCompaction(report));
 * ```
 */
export const compactionReport = (
  compaction: Compaction.Any,
  options: CompactionOptions,
): Effect.Effect<CompactionReport, ProveError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const aggregate = compaction.definition.of;
    const loader = yield* Source.loader(options);
    loader.adopt(aggregate);
    loader.adopt(compaction);
    const solver = yield* Smt.solver;
    const interpreter = Interpreter.make(loader, new Value.Run([]));
    const file = yield* fileOf(options.source);
    const modules = yield* Paths.reach(loader, file);
    const written = History.compactionIn(modules, compaction);
    if (!written)
      return yield* new Source.LoadError({
        file,
        message: `${file} does not declare the compaction ${compaction.compactionName}`,
      });
    const definition = yield* aggregateAt(modules, aggregate, file);
    const row = yield* History.compaction(
      solver,
      interpreter,
      aggregate,
      definition,
      compaction,
      written,
    );
    const made: CompactionReport = {
      compaction: compaction.compactionName,
      aggregate: aggregate.aggregateName,
      paths: row.paths,
      lossless: row.lossless,
      standing: row.standing,
      unread: Symbolic.unread(aggregate.definition.state, "state").map(
        (check) => `${check.at}: ${check.check}`,
      ),
      assumptions: [...ASSUMPTIONS.slice(0, 2), ...pure(loader.opaques())],
    };
    return made;
  }).pipe(
    Effect.scoped,
    Effect.catchTag(["LoadError", "SolverError"], (error) =>
      Effect.fail(new ProveError({ message: error.message })),
    ),
  );

/** Whether a report proves a roll-up loses nothing, from `initial` and onto the state it is made from. */
export const compactionProved = (report: CompactionReport): boolean =>
  report.lossless._tag === "Proved" && report.standing._tag === "Proved";

/**
 * Prove that a compaction's roll-up loses nothing, or fail with the report.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("bringing a wallet forward loses nothing", () =>
 *   Prove.compaction(BringForward, {
 *     source: new URL("../src/Wallet/BringForward.compaction.ts", import.meta.url),
 *   }).pipe(Effect.provide(NodeServices.layer)),
 * );
 * ```
 */
export const compaction = (
  compaction: Compaction.Any,
  options: CompactionOptions,
): Effect.Effect<
  CompactionReport,
  ProveError | CompactionNotProved,
  FileSystem.FileSystem | Path.Path
> =>
  compactionReport(compaction, options).pipe(
    Effect.flatMap((made) =>
      compactionProved(made)
        ? Effect.succeed(made)
        : Effect.fail(
            new CompactionNotProved({ message: `\n${renderCompaction(made)}`, report: made }),
          ),
    ),
  );

/** A compaction's report as text. */
export const renderCompaction = (report: CompactionReport): string => {
  const lines: Array<string> = [
    `${report.compaction}: rolls up ${report.aggregate}; ${report.paths} paths`,
    "",
  ];
  const line = (title: string, verdict: Verdict) => {
    lines.push(
      `${verdict._tag === "Proved" ? "✓" : "✗"} ${title}${verdict._tag === "Proved" ? "" : `: ${LABEL[verdict._tag]}`}`,
    );
    for (const text of detail(verdict)) lines.push(`    ${text}`);
  };
  line("Folded from the initial state, the roll-up gives the state back", report.lossless);
  line("Folded onto the state it was made from, the roll-up leaves it", report.standing);
  lines.push("", ...notes({ ...report, unkept: [] }));
  return lines.join("\n");
};

/** Where a rewrite is declared, and what else records on its aggregate. */
export interface RewriteOptions extends Source.Reading {
  /** The file the rewrite is declared in: `new URL("../src/ForgetOwner.rewrite.ts", import.meta.url)`, or a path. */
  readonly source: URL | string;
  /**
   * The compactions of the rewrite's aggregate, each with the file it is
   * declared in: a roll-up is an event an instance holds, so the rewrite is
   * taken through it too.
   */
  readonly compactions?: ReadonlyArray<{
    readonly compaction: Compaction.Any;
    readonly source: URL | string;
  }>;
}

/** A rewrite is not proved to keep its aggregate's invariants. The message is the report. */
export class RewriteNotProved extends Data.TaggedError("RewriteNotProved")<{
  readonly message: string;
  readonly report: RewriteReport;
}> {}

export interface RewriteReport {
  readonly rewrite: string;
  /** The aggregate whose instances it rewrites. */
  readonly aggregate: string;
  /** Whether it removes the instance: nothing is left to break a rule. */
  readonly deletes: boolean;
  /**
   * The parts of the state the rewrite can leave other than they were: the
   * proof lets the rewritten history differ from the recorded one there, and
   * nowhere else. `undefined` where the prover could not tell, and let it
   * differ everywhere.
   */
  readonly differs: ReadonlyArray<string> | undefined;
  /** Each invariant, after each command's events and each roll-up as the rewrite leaves them. */
  readonly invariants: ReadonlyArray<{
    readonly name: string;
    readonly steps: ReadonlyArray<{
      /** The command that records the events, or the compaction whose roll-up they are. */
      readonly step: string;
      readonly verdict: Verdict;
      readonly paths: number;
    }>;
  }>;
  /** Whether the state the rewritten events fold to stays in the state's schema, by step. */
  readonly schema: ReadonlyArray<{ readonly step: string; readonly verdict: Verdict }>;
  /**
   * The events the aggregate folds that none of its commands records and no
   * roll-up given is: a decision records them, and the rewrite is not taken
   * through what a decision records.
   */
  readonly outside: ReadonlyArray<string>;
  /** What the proof takes for granted. */
  readonly assumptions: ReadonlyArray<string>;
}

/**
 * Check that a rewrite keeps every invariant of its aggregate, whatever
 * history an instance holds, and say what was proved and what was not. An
 * instance refuses a rewrite that would break an invariant when it runs;
 * this says so before any instance meets such a history.
 *
 * **Example:** Printing the report
 * ```typescript
 * const report = yield* Prove.rewriteReport(ForgetOwner, {
 *   source: new URL("../src/Account/ForgetOwner.rewrite.ts", import.meta.url),
 * });
 * console.log(Prove.renderRewrite(report));
 * ```
 */
export const rewriteReport = (
  rewrite: Rewrite.Any,
  options: RewriteOptions,
): Effect.Effect<RewriteReport, ProveError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const aggregate = rewrite.definition.of;
    const loader = yield* Source.loader(options);
    loader.adopt(aggregate);
    loader.adopt(rewrite);
    const solver = yield* Smt.solver;
    const interpreter = Interpreter.make(loader, new Value.Run([]));
    const file = yield* fileOf(options.source);
    const modules = yield* Paths.reach(loader, file);
    const written = History.rewriteIn(modules, rewrite);
    if (!written)
      return yield* new Source.LoadError({
        file,
        message: `${file} does not declare the rewrite ${rewrite.rewriteName}`,
      });
    const definition = yield* aggregateAt(modules, aggregate, file);
    const names = Paths.invariantNames(definition);
    const sources: Array<History.Source> = aggregate.definition.commands.map((command) => ({
      _tag: "Command",
      command: command as unknown as Paths.CommandClass,
    }));
    const recorded = new Set<string>(
      aggregate.definition.commands.flatMap((command) => command.events.map((event) => event.tag)),
    );
    for (const given of options.compactions ?? []) {
      if (given.compaction.definition.of !== aggregate) continue;
      loader.adopt(given.compaction);
      const at = yield* fileOf(given.source);
      const found = History.compactionIn(yield* Paths.reach(loader, at), given.compaction);
      if (!found)
        return yield* new Source.LoadError({
          file: at,
          message: `${at} does not declare the compaction ${given.compaction.compactionName}`,
        });
      sources.push({ _tag: "Rollup", cls: given.compaction, written: found });
    }
    const deletes = rewrite.definition.delete === true;
    const { rows, differs } = deletes
      ? { rows: [], differs: [] }
      : yield* History.rewrite(
          solver,
          interpreter,
          aggregate,
          definition,
          rewrite,
          written,
          sources,
        );
    // A roll-up's events are ones the instance holds: what tags they are is not read here,
    // so an event only a roll-up gives is taken to be covered once a compaction is given.
    const rolled = (options.compactions ?? []).some(
      (given) => given.compaction.definition.of === aggregate,
    );
    const made: RewriteReport = {
      rewrite: rewrite.rewriteName,
      aggregate: aggregate.aggregateName,
      deletes,
      differs,
      invariants: names.map((name) => ({
        name,
        steps: rows.map((row) => ({
          step: row.step,
          verdict: row.verdicts.get(name)!,
          paths: row.paths,
        })),
      })),
      schema: rows.map((row) => ({ step: row.step, verdict: row.fits })),
      outside:
        deletes || rolled
          ? []
          : aggregate.definition.events
              .map((event) => event.tag)
              .filter((tag) => !recorded.has(tag)),
      assumptions: [
        ...ASSUMPTIONS,
        "every event an instance holds was recorded by one of its commands, or is a roll-up: one that was imported or seeded is not looked at",
        ...pure(loader.opaques()),
      ],
    };
    return made;
  }).pipe(
    Effect.scoped,
    Effect.catchTag(["LoadError", "SolverError"], (error) =>
      Effect.fail(new ProveError({ message: error.message })),
    ),
  );

/** Whether a report proves a rewrite keeps every invariant and the state's schema, through every event. */
export const rewriteProved = (report: RewriteReport): boolean =>
  report.deletes ||
  (report.outside.length === 0 &&
    report.schema.every((step) => step.verdict._tag === "Proved") &&
    report.invariants.every((invariant) =>
      invariant.steps.every((step) => step.verdict._tag === "Proved"),
    ));

/**
 * Prove that a rewrite keeps every invariant of its aggregate, or fail with
 * the report.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("forgetting an owner keeps the account's rules", () =>
 *   Prove.rewrite(ForgetOwner, {
 *     source: new URL("../src/Account/ForgetOwner.rewrite.ts", import.meta.url),
 *   }).pipe(Effect.provide(NodeServices.layer)),
 * );
 * ```
 */
export const rewrite = (
  rewrite: Rewrite.Any,
  options: RewriteOptions,
): Effect.Effect<RewriteReport, ProveError | RewriteNotProved, FileSystem.FileSystem | Path.Path> =>
  rewriteReport(rewrite, options).pipe(
    Effect.flatMap((made) =>
      rewriteProved(made)
        ? Effect.succeed(made)
        : Effect.fail(new RewriteNotProved({ message: `\n${renderRewrite(made)}`, report: made })),
    ),
  );

/** A rewrite's report as text, one invariant after another. */
export const renderRewrite = (report: RewriteReport): string => {
  const lines: Array<string> = [`${report.rewrite}: rewrites ${report.aggregate}`, ""];
  if (report.deletes) {
    lines.push("✓ It removes the instance: no state is left to break a rule");
    return lines.join("\n");
  }
  lines.push(
    report.differs === undefined
      ? "The prover could not tell what the rewrite leaves alone: the rewritten state may differ anywhere"
      : report.differs.length === 0
        ? "✓ It changes nothing the state keeps: the rewritten history folds to the same states"
        : `It can change ${report.differs.join(", ")} of the state, and nothing else`,
    "",
  );
  const section = (
    title: string,
    steps: ReadonlyArray<{ readonly step: string; readonly verdict: Verdict }>,
  ) => {
    const failed = steps.filter((step) => step.verdict._tag !== "Proved");
    lines.push(`${failed.length === 0 ? "✓" : "✗"} ${title}`);
    const passed = steps.filter((step) => step.verdict._tag === "Proved");
    if (passed.length > 0)
      lines.push(`    ✓ proved after ${passed.map((step) => step.step).join(", ")}`);
    for (const step of failed) {
      lines.push(`    ✗ after ${step.step}: ${LABEL[step.verdict._tag]}`);
      for (const text of detail(step.verdict)) lines.push(`        ${text}`);
    }
    lines.push("");
  };
  section("The state stays in its schema", report.schema);
  for (const invariant of report.invariants) section(invariant.name, invariant.steps);
  if (report.outside.length > 0)
    lines.push(
      `✗ ${report.aggregate} folds ${report.outside.join(", ")}, which none of its commands records: the rewrite is not taken through them`,
      "",
    );
  lines.push("Assuming:", ...report.assumptions.map((a) => `  - ${a}`));
  return lines.join("\n");
};
