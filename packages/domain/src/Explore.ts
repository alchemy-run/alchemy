/**
 * Explores an aggregate: runs every sequence of its commands on a new
 * instance, up to a number of commands, and says which events, rejections and
 * states it reached, with the shortest story for each, and whether an
 * invariant broke on the way.
 *
 * Nobody lists values to try. The explorer reads the TypeScript of `decide`
 * and `evolve`, keeps each command's fields unknown along a sequence, and asks
 * a solver for values that take the sequence down each path. Every story it
 * reports ran on the real code.
 *
 * It needs `z3-solver` and `oxc-parser`, both optional peers, and runs under
 * Node.
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Aggregate from "./Aggregate.ts";
import type * as Api from "./Api.ts";
import * as ModelSearch from "./Explore/internal/ModelSearch.ts";
import type { Found, Move, Story } from "./Explore/internal/Search.ts";
import * as Search from "./Explore/internal/Search.ts";
import type * as Model from "./Model.ts";
import * as Interpreter from "./Prove/internal/Interpreter.ts";
import * as Paths from "./Prove/internal/Paths.ts";
import * as Smt from "./Prove/internal/Smt.ts";
import * as Source from "./Prove/internal/Source.ts";
import * as Symbolic from "./Prove/internal/Symbolic.ts";
import * as Value from "./Prove/internal/Value.ts";

export type { Move, Outcome, Story } from "./Explore/internal/Search.ts";
export type { Ending, Skipped, Step } from "./Explore/internal/ModelSearch.ts";

export interface Options {
  /** The file the aggregate is declared in: `new URL("../src/Account.ts", import.meta.url)`, or a path. */
  readonly source: URL | string;
  /**
   * The most commands in a sequence.
   * @default 3
   */
  readonly depth?: number;
  /**
   * The most sequences to run before stopping.
   * @default 100000
   */
  readonly budget?: number;
  /** What `check` passes with, though it leaves part of the search undone. */
  readonly allow?: {
    /** Pass when the search stops at its budget before every sequence is run. */
    readonly truncated?: boolean;
  };
}

export interface ModelOptions {
  /** The file the model is declared in: `new URL("../src/Bank.model.ts", import.meta.url)`, or a path. */
  readonly source: URL | string;
  /** The Apis callers reach the model through: their commands are the ones a sequence is made of. */
  readonly apis: ReadonlyArray<Api.Any>;
  /**
   * The most commands callers send in a sequence. What the policies send in
   * reaction does not count.
   * @default 2
   */
  readonly depth?: number;
  /**
   * The most sequences to run before stopping.
   * @default 100000
   */
  readonly budget?: number;
  /**
   * The most instances of one aggregate callers address in a sequence.
   * @default 2
   */
  readonly instances?: number;
  /** What `check` passes with, though it leaves part of the search undone. */
  readonly allow?: {
    /** Pass when the search stops at its budget before every sequence is run. */
    readonly truncated?: boolean;
    /** The policies and sagas the explorer may leave out, by name. */
    readonly skipped?: ReadonlyArray<string>;
  };
}

/** The explorer could not start: a file did not load, or the solver is missing. */
export class ExploreError extends Data.TaggedError("ExploreError")<{ readonly message: string }> {}

/** A sequence of commands breaks an invariant. The message is the report. */
export class InvariantBroken extends Data.TaggedError("InvariantBroken")<{
  readonly message: string;
  readonly report: Report | ModelReport;
}> {}

/**
 * No invariant was seen to break, but part of the search was not done, so the
 * search does not say that none does. `reasons` names each part.
 */
export class Incomplete extends Data.TaggedError("Incomplete")<{
  readonly message: string;
  readonly reasons: ReadonlyArray<string>;
  readonly report: Report | ModelReport;
}> {}

export interface Report extends Found {
  readonly aggregate: string;
  readonly depth: number;
}

export interface ModelReport extends ModelSearch.Found {
  readonly model: string;
  readonly apis: ReadonlyArray<string>;
  readonly depth: number;
}

type Requirements = FileSystem.FileSystem | Path.Path;

const isModel = (target: Aggregate.Any | Model.Any): target is Model.Any => "modelName" in target;

/**
 * Run every sequence of up to `depth` commands on a new instance, and say
 * what was reached.
 *
 * **Example:** Printing the report
 * ```typescript
 * const report = yield* Explore.report(Account, {
 *   source: new URL("../src/Account/Account.aggregate.ts", import.meta.url),
 * });
 * console.log(Explore.render(report));
 * ```
 */
export function report(
  aggregate: Aggregate.Any,
  options: Options,
): Effect.Effect<Report, ExploreError, Requirements>;
/**
 * Run every sequence of up to `depth` commands callers can send through the
 * Apis, on a model with nothing in it. After each command the policies react,
 * and the commands they send run before the next one.
 *
 * **Example:** Printing the report
 * ```typescript
 * const report = yield* Explore.report(Bank, {
 *   source: new URL("../src/Bank.model.ts", import.meta.url),
 *   apis: [CustomerApi, SupportApi],
 * });
 * console.log(Explore.render(report));
 * ```
 */
export function report(
  model: Model.Any,
  options: ModelOptions,
): Effect.Effect<ModelReport, ExploreError, Requirements>;
export function report(
  target: Aggregate.Any | Model.Any,
  options: Options | ModelOptions,
): Effect.Effect<Report | ModelReport, ExploreError, Requirements> {
  return isModel(target)
    ? reportModel(target, options as ModelOptions)
    : reportAggregate(target, options);
}

const reportModel = (
  model: Model.Any,
  options: ModelOptions,
): Effect.Effect<ModelReport, ExploreError, Requirements> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const source = options.source;
    const file =
      typeof source === "string"
        ? path.resolve(source)
        : yield* path
            .fromFileUrl(source)
            .pipe(
              Effect.mapError(
                (error) => new ExploreError({ message: `${String(source)}: ${error.message}` }),
              ),
            );
    const loader = yield* Source.loader;
    const solver = yield* Smt.solver;
    const interpreter = Interpreter.make(loader, new Value.Run([]));
    loader.adopt(model);
    const located = yield* ModelSearch.locate(loader, interpreter, model, file);
    if (located.missing.length > 0)
      return yield* new ExploreError({
        message: `${file} does not import the file that declares ${located.missing.join(", ")}`,
      });
    if (located.unread.length > 0)
      return yield* new ExploreError({
        message: `the explorer does not find the invariants ${located.unread.join(", ")} in the source: each must be written in its definition, as a property`,
      });
    const depth = options.depth ?? 2;
    const found = yield* ModelSearch.search(
      solver,
      interpreter,
      located,
      options.apis.flatMap((api) => api.commands as ReadonlyArray<unknown>),
      { depth, budget: options.budget ?? 100_000, instances: options.instances ?? 2 },
    );
    const made: ModelReport = {
      model: model.modelName,
      apis: options.apis.map((api) => api.apiName),
      depth,
      ...found,
    };
    return made;
  }).pipe(
    Effect.scoped,
    Effect.catchTag(["LoadError", "SolverError"], (error) =>
      Effect.fail(new ExploreError({ message: error.message })),
    ),
  );

const reportAggregate = (
  aggregate: Aggregate.Any,
  options: Options,
): Effect.Effect<Report, ExploreError, Requirements> =>
  Effect.gen(function* () {
    const { loader, definition } = yield* Paths.load(aggregate, options.source);
    const solver = yield* Smt.solver;
    const interpreter = Interpreter.make(loader, new Value.Run([]));
    const depth = options.depth ?? 3;
    const found = yield* Search.search(solver, interpreter, aggregate, definition, {
      depth,
      budget: options.budget ?? 100_000,
    });
    const made: Report = { aggregate: aggregate.aggregateName, depth, ...found };
    return made;
  }).pipe(
    Effect.scoped,
    Effect.catchTag(["LoadError", "SolverError"], (error) =>
      Effect.fail(new ExploreError({ message: error.message })),
    ),
  );

/**
 * Explore an aggregate, and fail with the report when a sequence of commands
 * breaks an invariant.
 *
 * It also fails, with `Incomplete`, when part of the search was not done:
 * code it could not read, a search that stopped at its budget, a command no
 * state accepts, no state reached at all.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("no three commands break an account", () =>
 *   Explore.check(Account, {
 *     source: new URL("../src/Account/Account.aggregate.ts", import.meta.url),
 *   }).pipe(Effect.provide(NodeServices.layer)),
 * );
 * ```
 */
export function check(
  aggregate: Aggregate.Any,
  options: Options,
): Effect.Effect<Report, ExploreError | InvariantBroken | Incomplete, Requirements>;
/**
 * Explore a model, and fail with the report when a sequence of commands
 * breaks an invariant of one of its aggregates or of the model.
 *
 * It also fails, with `Incomplete`, when part of the search was not done:
 * code it could not read, a policy it left out, a search that stopped at its
 * budget, an invariant no sequence reached. `allow` names the parts a pass
 * may leave undone.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("no two commands break the bank", () =>
 *   Explore.check(Bank, {
 *     source: new URL("../src/Bank.model.ts", import.meta.url),
 *     apis: [CustomerApi, SupportApi],
 *   }).pipe(Effect.provide(NodeServices.layer)),
 * );
 * ```
 */
export function check(
  model: Model.Any,
  options: ModelOptions,
): Effect.Effect<ModelReport, ExploreError | InvariantBroken | Incomplete, Requirements>;
export function check(
  target: Aggregate.Any | Model.Any,
  options: Options | ModelOptions,
): Effect.Effect<Report | ModelReport, ExploreError | InvariantBroken | Incomplete, Requirements> {
  const made: Effect.Effect<Report | ModelReport, ExploreError, Requirements> = isModel(target)
    ? reportModel(target, options as ModelOptions)
    : reportAggregate(target, options);
  return made.pipe(
    Effect.flatMap((made): Effect.Effect<Report | ModelReport, InvariantBroken | Incomplete> => {
      if (
        made.invariants.some((invariant) => invariant.broken) ||
        ("rules" in made && made.rules.some((rule) => rule.broken))
      )
        return Effect.fail(new InvariantBroken({ message: `\n${render(made)}`, report: made }));
      const reasons = undone(made, options.allow ?? {});
      return reasons.length > 0
        ? Effect.fail(
            new Incomplete({
              message: `\nNo invariant was seen to break, but the search was not whole:\n${reasons
                .map((reason) => `  ✗ ${reason}`)
                .join("\n")}\n\n${render(made)}`,
              reasons,
              report: made,
            }),
          )
        : Effect.succeed(made);
    }),
  );
}

/** Each part of a search that was not done, so that a pass would say less than it seems to. */
const undone = (
  report: Report | ModelReport,
  allow: NonNullable<ModelOptions["allow"]>,
): ReadonlyArray<string> => {
  const out: Array<string> = [];
  if (report.unread.length > 0)
    out.push(
      `the explorer could not read ${report.unread
        .map((error) => `${error.file}:${error.line}`)
        .join(", ")}: the sequences through it were not run`,
    );
  if (report.disagreements.length > 0)
    out.push(
      `the real code disagrees with what the explorer read in ${count(report.disagreements.length)} sequences`,
    );
  if (report.undecided.length > 0)
    out.push(
      `the solver gave up on ${count(report.undecided.reduce((sum, entry) => sum + entry.times, 0))} questions`,
    );
  if (report.dead.length > 0)
    out.push(
      `${report.dead.join(", ")} ${report.dead.length === 1 ? "is" : "are"} never accepted: no state the invariants allow lets ${report.dead.length === 1 ? "it" : "them"} record an event`,
    );
  if (report.truncated && allow.truncated !== true)
    out.push(
      `the search stopped at its budget: only every sequence of up to ${report.complete} commands was run (allow: { truncated: true } passes with this)`,
    );
  if ("model" in report) {
    const left = [...new Set(report.skipped.map((skipped) => skipped.policy))].filter(
      (name) => !(allow.skipped ?? []).includes(name),
    );
    if (left.length > 0)
      out.push(
        `${left.join(", ")} ${left.length === 1 ? "was" : "were"} not followed: the sequences ran as if ${left.length === 1 ? "it" : "they"} did nothing (allow: { skipped: [${left.map((name) => JSON.stringify(name)).join(", ")}] } passes with this)`,
      );
    if (report.unsettled > 0)
      out.push(
        `${count(report.unsettled)} sequences were still reacting after the most the explorer follows`,
      );
  }
  const name = (invariant: { readonly aggregate?: string; readonly name: string }) =>
    invariant.aggregate === undefined ? invariant.name : `${invariant.aggregate}.${invariant.name}`;
  if (report.states === 0) out.push("no sequence recorded an event, so no state was looked at");
  else {
    const unseen = report.invariants.filter(
      (invariant) => !invariant.proved && invariant.states === 0,
    );
    if (unseen.length > 0)
      out.push(
        `${unseen.map(name).join(", ")} ${unseen.length === 1 ? "was" : "were"} not looked at in any state: no sequence changed ${unseen.length === 1 ? "its aggregate" : "their aggregates"}`,
      );
    if ("model" in report) {
      const unruled = report.rules.filter((rule) => rule.states === 0);
      if (unruled.length > 0)
        out.push(
          `${unruled.map((rule) => `${report.model}.${rule.name}`).join(", ")} ${unruled.length === 1 ? "was" : "were"} not looked at: no sequence that changed a state came to rest`,
        );
    }
  }
  return out;
};

const held = (name: string, invariant: { readonly proved: boolean; readonly states: number }) =>
  invariant.proved
    ? `✓ ${name} holds in every state: no command can break it`
    : invariant.states > 0
      ? `✓ ${name} holds in the ${count(invariant.states)} states reached`
      : `? ${name} was not looked at: no state was reached`;

const tagOf = (value: unknown): string => String((value as { readonly _tag?: unknown })._tag);

const result = (move: Move): string =>
  move.outcome._tag === "Rejected"
    ? `✗ ${tagOf(move.outcome.rejection)}`
    : move.outcome.events.map(tagOf).join(", ");

/** A story as text, one command per line. */
const lines = (story: Story, indent: string): ReadonlyArray<string> => {
  const timed = new Set(story.map((move) => DateTime.toEpochMillis(move.now))).size > 1;
  const sent = story.map((move) =>
    [
      Symbolic.show(move.command),
      ...move.context.map((entry) => `as ${Symbolic.show(entry.value)}`),
      ...(timed ? [`at ${DateTime.formatIso(move.now)}`] : []),
    ].join(" "),
  );
  const width = Math.max(...sent.map((text) => text.length));
  return story.map(
    (move, index) => `${indent}${index + 1}. ${sent[index]!.padEnd(width)}  → ${result(move)}`,
  );
};

const count = (n: number): string => n.toLocaleString("en-US");

/**
 * A model's story as text: each command a caller sends or a schedule that
 * comes due, then what the policies and sagas sent because of it.
 */
const modelLines = (story: ModelSearch.Story, indent: string): ReadonlyArray<string> => {
  const timed = new Set(story.map((step) => DateTime.toEpochMillis(step.now))).size > 1;
  let sent = 0;
  return story.map((step) => {
    const text = [
      `${step.aggregate} ${Symbolic.show(step.id)}`,
      Symbolic.show(step.command),
      ...step.context.map((entry) => `as ${Symbolic.show(entry.value)}`),
      ...(timed ? [`at ${DateTime.formatIso(step.now)}`] : []),
    ].join(" ");
    if (step.after !== undefined)
      return `${indent}${++sent}. after ${step.after}${step.by === undefined ? "" : `, ${step.by}`}: ${text}  → ${result(step)}`;
    return step.by === undefined
      ? `${indent}${++sent}. ${text}  → ${result(step)}`
      : `${indent}   ↳ ${step.by}: ${text}  → ${result(step)}`;
  });
};

const renderModel = (report: ModelReport): string => {
  const out: Array<string> = [
    `${report.model}: every sequence of up to ${report.depth} ${report.depth === 1 ? "command" : "commands"} through ${report.apis.join(", ")}, with the policies and sagas that react and the schedules that come due`,
    `${count(report.sequences)} sequences, ${count(report.states)} states${
      report.truncated
        ? ` (stopped at the budget: every sequence of up to ${report.complete} commands was run, and some of ${report.complete + 1})`
        : ""
    }`,
    "",
    `Policies followed: ${report.followed.length > 0 ? report.followed.join(", ") : "none"}`,
  ];
  if (report.idle.length > 0)
    out.push(`Policies with no event to react to: ${report.idle.join(", ")}`);
  if (report.sagas.length > 0) out.push(`Sagas followed: ${report.sagas.join(", ")}`);
  if (report.unstarted.length > 0)
    out.push(`Sagas no sequence started: ${report.unstarted.join(", ")}`);
  if (report.skipped.length > 0)
    out.push(
      "Not followed: the sequences ran as if these did nothing",
      ...report.skipped.map(
        (skipped) =>
          `  ${skipped.policy}  ${skipped.file === undefined ? "" : `${skipped.file}:${skipped.line}  `}${skipped.reason}`,
      ),
    );
  out.push("");
  for (const invariant of report.invariants) {
    const name = `${invariant.aggregate}.${invariant.name}`;
    if (!invariant.broken) {
      out.push(held(name, invariant));
      continue;
    }
    const last = invariant.broken[invariant.broken.length - 1];
    if (!last) {
      out.push(`✗ ${name} breaks on a new instance`);
      continue;
    }
    out.push(`✗ ${name} breaks`, ...modelLines(invariant.broken, "    "));
    if (last.outcome._tag === "Accepted")
      out.push(`    state  ${Symbolic.show(last.outcome.state)}`);
  }
  for (const rule of report.rules) {
    if (!rule.broken) {
      out.push(
        rule.states > 0
          ? `✓ ${report.model}.${rule.name} holds whenever nothing is left to react, in the ${count(rule.states)} sequences that came to rest`
          : `? ${report.model}.${rule.name} was not looked at: no sequence that changed a state came to rest`,
      );
      continue;
    }
    out.push(`✗ ${report.model}.${rule.name} breaks`, ...modelLines(rule.broken, "    "));
  }
  const ended = report.endings.filter((ending) => ending.story);
  const open = report.endings.filter((ending) => !ending.story);
  if (ended.length > 0) out.push("", "How the sagas end", "");
  for (const ending of ended)
    out.push(`  ${ending.saga} ${ending.ending}`, ...modelLines(ending.story!, "      "), "");
  if (open.length > 0)
    out.push(
      `Endings not reached in ${report.depth} ${report.depth === 1 ? "command" : "commands"}`,
      ...open.map((ending) => `  ${ending.saga} ${ending.ending}`),
    );
  const arrow = (outcome: ModelSearch.Outcome) =>
    `${outcome.aggregate}.${outcome.command} ${outcome.kind === "records" ? "→" : "✗"} ${outcome.tag}`;
  const reached = report.outcomes.filter((outcome) => outcome.story);
  const missed = report.outcomes.filter((outcome) => !outcome.story);
  out.push("", `Reached ${reached.length} of ${report.outcomes.length} outcomes`, "");
  for (const outcome of reached)
    out.push(`  ${arrow(outcome)}`, ...modelLines(outcome.story!, "      "), "");
  if (missed.length > 0)
    out.push(
      `Not reached in ${report.depth} ${report.depth === 1 ? "command" : "commands"}`,
      ...missed.map((outcome) => `  ${arrow(outcome)}`),
      "",
    );
  const states = report.reached
    .filter((state) => state.story)
    .map((state) => `${state.aggregate}.${state.tag}`);
  const never = report.reached
    .filter((state) => !state.story)
    .map((state) => `${state.aggregate}.${state.tag}`);
  out.push(
    `States reached: ${states.join(", ")}${never.length > 0 ? `; not reached: ${never.join(", ")}` : ""}`,
  );
  if (report.failures.length > 0) {
    out.push("", "A policy does not handle a rejection: its handler fails");
    for (const failure of report.failures)
      out.push(
        `  ${failure.policy} fails with ${failure.tag}`,
        ...modelLines(failure.story, "      "),
      );
  }
  if (report.unsettled > 0)
    out.push(
      "",
      `${count(report.unsettled)} sequences were still reacting after the most reactions the explorer follows`,
    );
  if (report.unread.length > 0)
    out.push(
      "",
      "Not read",
      ...report.unread.map((error) => `  ${error.file}:${error.line}  ${error.reason}`),
    );
  if (report.disagreements.length > 0)
    out.push(
      "",
      "The real code disagrees with the explorer",
      ...report.disagreements.map((reason) => `  ${reason}`),
    );
  if (report.undecided.length > 0)
    out.push(
      "",
      "The solver gave up",
      ...report.undecided.map((entry) => `  ${count(entry.times)} times: ${entry.reason}`),
    );
  if (report.dead.length > 0) out.push("", `Never accepted: ${report.dead.join(", ")}`);
  return out.join("\n");
};

/** A report as text: the invariants, then every outcome with its shortest story. */
export const render = (report: Report | ModelReport): string => {
  if ("model" in report) return renderModel(report);
  const out: Array<string> = [
    `${report.aggregate}: every sequence of up to ${report.depth} commands on a new instance`,
    `${count(report.sequences)} sequences, ${count(report.states)} states${
      report.truncated
        ? ` (stopped at the budget: every sequence of up to ${report.complete} commands was run, and some of ${report.complete + 1})`
        : ""
    }`,
    "",
  ];
  for (const invariant of report.invariants) {
    if (!invariant.broken) {
      out.push(held(invariant.name, invariant));
      continue;
    }
    const last = invariant.broken[invariant.broken.length - 1];
    if (!last) {
      out.push(`✗ ${invariant.name} breaks on a new instance`);
      continue;
    }
    out.push(`✗ ${invariant.name} breaks`, ...lines(invariant.broken, "    "));
    if (last.outcome._tag === "Accepted")
      out.push(`    state  ${Symbolic.show(last.outcome.state)}`);
  }
  const reached = report.outcomes.filter((outcome) => outcome.story);
  const missed = report.outcomes.filter((outcome) => !outcome.story);
  out.push("", `Reached ${reached.length} of ${report.outcomes.length} outcomes`, "");
  for (const outcome of reached)
    out.push(
      `  ${outcome.command} ${outcome.kind === "records" ? "→" : "✗"} ${outcome.tag}`,
      ...lines(outcome.story!, "      "),
      "",
    );
  if (missed.length > 0)
    out.push(
      `Not reached in ${report.depth} commands`,
      ...missed.map(
        (outcome) =>
          `  ${outcome.command} ${outcome.kind === "records" ? "→" : "✗"} ${outcome.tag}`,
      ),
      "",
    );
  const states = report.reached.filter((state) => state.story).map((state) => state.tag);
  const never = report.reached.filter((state) => !state.story).map((state) => state.tag);
  out.push(
    `States reached: ${states.join(", ")}${never.length > 0 ? `; not reached: ${never.join(", ")}` : ""}`,
  );
  if (report.unread.length > 0)
    out.push(
      "",
      "Not read",
      ...report.unread.map((error) => `  ${error.file}:${error.line}  ${error.reason}`),
    );
  if (report.disagreements.length > 0)
    out.push(
      "",
      "The real code disagrees with the explorer",
      ...report.disagreements.map((reason) => `  ${reason}`),
    );
  if (report.undecided.length > 0)
    out.push(
      "",
      "The solver gave up",
      ...report.undecided.map((entry) => `  ${count(entry.times)} times: ${entry.reason}`),
    );
  if (report.dead.length > 0) out.push("", `Never accepted: ${report.dead.join(", ")}`);
  return out.join("\n");
};
