/**
 * Verifies a model: one call that proves what can be proved, searches for a
 * sequence that breaks the rest, and runs every sequence it finds on the real
 * model in memory.
 *
 * - An aggregate's invariants and transitions are proved for every state and
 *   every input, where a solver can decide them.
 * - The others, the model's invariants and what it says holds in the end are
 *   checked in every sequence of a few commands callers can send, with the
 *   policies, sagas, views and schedules that follow, every answer an
 *   external system may give, each event delivered twice, and the reactions
 *   that wait together run in every order.
 * - With a `Story` runner, each sequence found is run again on the real
 *   model: the policies, sagas and views the explorer read then do what it
 *   read, or the report says where they do not.
 *
 * It uses `z3-solver` and `oxc-parser`, which are loaded only when it runs, and runs under
 * Node.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Aggregate from "./Aggregate.ts";
import type * as Api from "./Api.ts";
import * as Explore from "./Explore.ts";
import type * as ModelSearch from "./Explore/internal/ModelSearch.ts";
import * as Script from "./Explore/internal/Script.ts";
import type * as Model from "./Model.ts";
import * as Prove from "./Prove.ts";
import * as Symbolic from "./Prove/internal/Symbolic.ts";
import { Story } from "./Story.ts";

export interface Options {
  /** The Apis callers reach the model through: their commands are the ones a sequence is made of. */
  readonly apis: ReadonlyArray<Api.Any>;
  /**
   * The file the model is declared in. Left out, it is found from the test
   * file that calls: the file it imports, directly or not, that declares the
   * model.
   */
  readonly source?: URL | string;
  /**
   * A story runner for the model: `Story.make(Bank, { layer, stub })`. Each
   * sequence found is run with it on the real model in memory. The external
   * systems the model calls must be in `stub`, so the run gives them the
   * answers the solver picked.
   */
  readonly story?: (...steps: ReadonlyArray<never>) => Effect.Effect<void, unknown, never>;
  /**
   * The most commands callers send in a sequence.
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
  /** The ways delivery goes wrong that every sequence is run with: both, unless turned off. */
  readonly faults?: Explore.ModelOptions["faults"];
  /**
   * Longer sequences to run after every short one, each a walk of commands
   * picked at random: 200 of up to 12 commands, unless said otherwise. The
   * same `seed` picks the same walks. `{ count: 0 }` runs none.
   */
  readonly walks?: Explore.ModelOptions["walks"];
  /** What a pass may leave undone. */
  readonly allow?: Explore.ModelOptions["allow"];
  /**
   * How far a rule has to be known to hold, for the rules named: a rule in
   * `proved` that is only checked fails the verification.
   */
  readonly require?: Require;
}

/** The rules a pass has to do more than check. */
export interface Require {
  /** The rules that have to be proved, each as the report names it: `Account.NeverOverdrawn`. */
  readonly proved?: ReadonlyArray<string>;
}

/** Each rule that is required to be proved and is not, as a part of the check left undone. */
const required = (
  rules: ReadonlyArray<{ readonly name: string; readonly standing: Rule["standing"] }>,
  require: Require | undefined,
): ReadonlyArray<string> =>
  (require?.proved ?? []).flatMap((name) => {
    const rule = rules.find((rule) => rule.name === name);
    return !rule
      ? [`${name} is required to be proved, and the model has no rule of that name`]
      : rule.standing === "proved" || rule.standing === "broken"
        ? []
        : [
            `${name} is required to be proved, and is ${rule.standing === "checked" ? "only checked" : "not looked at"}`,
          ];
  });

/** The verification could not start: a file did not load, or the solver is missing. */
export class VerifyError extends Data.TaggedError("VerifyError")<{ readonly message: string }> {}

/** A rule is broken, a sequence does not run on the real model, or part of the check was not done. */
export class NotVerified extends Data.TaggedError("NotVerified")<{
  readonly message: string;
  readonly report: Report;
}> {}

/** One rule of the model, and how far it is known to hold. */
export interface Rule {
  /** `Account.NeverOverdrawn`, or `Bank.NoTransferLeftPending`. */
  readonly name: string;
  readonly kind: "invariant" | "transition" | "model invariant" | "relation" | "eventually";
  /**
   * `proved`: no state and no input break it. `checked`: no sequence run
   * breaks it. `broken`: `story` breaks it. `unseen`: no sequence reached it.
   */
  readonly standing: "proved" | "checked" | "broken" | "unseen";
  /** How many states, steps or sequences it was looked at in. */
  readonly seen: number;
  readonly story: ModelSearch.Story | undefined;
  /**
   * For a relation that is checked and not proved: what the proof fails on.
   * A proof starts from any states the rules allow, so it can fail on states
   * no sequence of commands reaches.
   */
  readonly unproved?: { readonly by: string; readonly verdict: Prove.Verdict } | undefined;
}

/** A sequence the explorer found, run on the real model. */
export interface Run {
  /** What the sequence shows: `Account.WithdrawMoney → MoneyWithdrawn`. */
  readonly of: string;
  readonly story: ModelSearch.Story;
  /** `undefined` when the real model did what the explorer read. */
  readonly failure: string | undefined;
}

export interface Report {
  readonly model: string;
  readonly rules: ReadonlyArray<Rule>;
  readonly explored: Explore.ModelReport;
  /** The sequences run on the real model: empty without a `story` runner. */
  readonly runs: ReadonlyArray<Run>;
  /** How many of them are the walks of commands picked at random. */
  readonly walked: number;
  /** The sequences a story cannot run: they need an event delivered twice, a step run twice or a late schedule. */
  readonly unrun: number;
  /** Each part of the check that was not done. */
  readonly undone: ReadonlyArray<string>;
  /** What the verification takes for granted. */
  readonly assumptions: ReadonlyArray<string>;
}

type Requirements = FileSystem.FileSystem | Path.Path;

/** The files in the call stack that are not this package's, nearest first. */
const callers = (stack: string | undefined, own: string): ReadonlyArray<string> => {
  const files: Array<string> = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = /((?:file:\/\/)?\/[^\s():]+\.[cm]?[jt]sx?)(?:\?[^\s():]*)?:\d+:\d+/.exec(line);
    if (!match) continue;
    const file = match[1]!.startsWith("file://") ? decodeURI(match[1]!.slice(7)) : match[1]!;
    if (file.startsWith(own) || file.includes("/node_modules/")) continue;
    if (!files.includes(file)) files.push(file);
  }
  return files;
};

/** The most files read to find the one that declares a model. */
const MAX_FILES = 400;

/**
 * The file that declares the model, among the ones the calling test imports.
 * Each is read as text, never loaded: loading a test file would run it.
 */
const locate = Effect.fn(function* (
  name: string,
  kind: "Model" | "Aggregate",
  from: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const declares = new RegExp(
    `\\b${kind}\\(\\s*["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`,
  );
  const seen = new Set(from);
  const pending = [...from];
  while (pending.length > 0 && seen.size <= MAX_FILES) {
    const file = pending.shift()!;
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
    if (text === undefined) continue;
    if (declares.test(text)) return file;
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = path.resolve(path.dirname(file), match[1]!);
      const candidates = /\.[cm]?[jt]sx?$/.test(base)
        ? [base]
        : [`${base}.ts`, `${base}.tsx`, path.resolve(base, "index.ts")];
      for (const candidate of candidates)
        if (!seen.has(candidate)) {
          seen.add(candidate);
          pending.push(candidate);
        }
    }
  }
  return yield* new VerifyError({
    message: `no file the test imports declares the ${kind.toLowerCase()} ${name}: pass its file as \`source\``,
  });
});

const OWN = (() => {
  const url = import.meta.url;
  const file = url.startsWith("file://") ? decodeURI(url.slice(7)) : url;
  return file.slice(0, file.lastIndexOf("/") + 1);
})();

const ASSUMPTIONS = [
  "whole numbers are exact: a number stays within ±2^53, and a bigint has no limit",
  `a list an input holds has up to ${Symbolic.MAX_ITEMS} items more than its schema asks for`,
  "an external system answers what its schema allows, and nothing else",
  "middleware lets every caller in: who sends a command is anyone its request context allows",
  "what a projection writes, and what a stream or a query gives, is not checked: only what a projection is given",
];

const count = (n: number): string => n.toLocaleString("en-US");

const rulesOf = (explored: Explore.ModelReport): ReadonlyArray<Rule> => [
  ...explored.invariants.map((rule): Rule => ({
    name: `${rule.aggregate}.${rule.name}`,
    kind: rule.kind,
    standing: rule.broken
      ? "broken"
      : rule.proved
        ? "proved"
        : rule.states > 0
          ? "checked"
          : "unseen",
    seen: rule.states,
    story: rule.broken,
  })),
  ...explored.rules.map((rule): Rule => ({
    name: `${explored.model}.${rule.name}`,
    kind: rule.kind === "relation" ? "relation" : "model invariant",
    standing: rule.broken
      ? "broken"
      : rule.proved
        ? "proved"
        : rule.states > 0
          ? "checked"
          : "unseen",
    seen: rule.states,
    story: rule.broken,
    unproved: rule.unproved,
  })),
  ...explored.eventually.map((rule): Rule => ({
    name: `${explored.model}.${rule.name}`,
    kind: "eventually",
    standing: rule.broken ? "broken" : rule.states > 0 ? "checked" : "unseen",
    seen: rule.states,
    story: rule.broken,
  })),
];

/** Every sequence a report shows, each once, with what it shows. */
const storiesOf = (explored: Explore.ModelReport) => {
  const made: Array<{ readonly of: string; readonly story: ModelSearch.Story }> = [];
  const add = (of: string, story: ModelSearch.Story | undefined) => {
    if (story && story.length > 0) made.push({ of, story });
  };
  for (const rule of explored.invariants) add(`breaks ${rule.aggregate}.${rule.name}`, rule.broken);
  for (const rule of explored.rules) add(`breaks ${explored.model}.${rule.name}`, rule.broken);
  for (const rule of explored.eventually)
    add(`ends without ${explored.model}.${rule.name}`, rule.broken);
  for (const outcome of explored.outcomes)
    add(
      `${outcome.aggregate === undefined ? "" : `${outcome.aggregate}.`}${outcome.command} ${outcome.kind === "records" ? "→" : "✗"} ${outcome.tag}`,
      outcome.story,
    );
  for (const ending of explored.endings) add(`${ending.saga} ${ending.ending}`, ending.story);
  return made;
};

/** Each walk of a report, as a sequence to run. */
const walksOf = (explored: Explore.ModelReport) =>
  explored.walks.stories.map((story, index) => ({
    of: `walk ${index + 1} of ${explored.walks.stories.length}, seed ${explored.walks.seed}`,
    story,
    walk: true as const,
  }));

const foundIn = (explored: Explore.ModelReport) => {
  const found: ReadonlyArray<{
    readonly of: string;
    readonly story: ModelSearch.Story;
    readonly walk?: true;
  }> = [...storiesOf(explored), ...walksOf(explored)];
  return found;
};

/** A found sequence as the real steps of a `Story`, for the model's own classes. */
const stepsOf = (model: Model.Any, story: ModelSearch.Story): ReadonlyArray<unknown> => {
  const aggregates = new Map(
    (model.aggregates as ReadonlyArray<Aggregate.Any>).map((cls) => [cls.aggregateName, cls]),
  );
  const ref = (aggregate: string, id: string) =>
    Aggregate.makeRef(aggregates.get(aggregate)!, id as never);
  return Script.ops(story).flatMap((op): ReadonlyArray<unknown> => {
    switch (op._tag) {
      case "Provide":
        return [Story.provide(op.tag as never, op.value as never)];
      case "Clock":
        return [Story.clock(op.at)];
      case "When":
        return [Story.when(op.command as never)];
      case "Rejected":
        return [Story.rejected(op.rejection as never)];
      case "Call":
        return [Story.call(op.asked.op as never, {})];
      case "Answer":
        return [
          op.asked.failed
            ? Story.fail(op.asked.op as never, op.asked.answer as never)
            : Story.succeed(op.asked.op as never, op.asked.answer as never),
        ];
      case "Then":
        return [Story.then(ref(op.aggregate, op.id), ...(op.events as ReadonlyArray<never>))];
      case "Note":
        return [];
    }
  });
};

/**
 * Verify a model, and say for each of its rules how far it is known to hold.
 *
 * **Example:** Printing the report
 * ```typescript
 * const report = yield* Verify.report(Bank, { apis: [CustomerApi, SupportApi] });
 * console.log(Verify.render(report));
 * ```
 */
export const report = (
  model: Model.Any,
  options: Options,
): Effect.Effect<Report, VerifyError, Requirements> => {
  // The call stack is read here, while the test that calls is still on it.
  const from = callers(new Error("caller").stack, OWN);
  return Effect.gen(function* () {
    const source = options.source ?? (yield* locate(model.modelName, "Model", from));
    const explored = yield* Explore.report(model, {
      source,
      apis: options.apis,
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.instances === undefined ? {} : { instances: options.instances }),
      ...(options.faults === undefined ? {} : { faults: options.faults }),
      walks: options.walks ?? { count: 200 },
    }).pipe(Effect.mapError((error) => new VerifyError({ message: error.message })));
    const runs: Array<Run> = [];
    let unrun = 0;
    let walked = 0;
    const story = options.story as
      | ((...steps: ReadonlyArray<unknown>) => Effect.Effect<void, unknown>)
      | undefined;
    if (story) {
      const ran = new Set<string>();
      for (const found of foundIn(explored)) {
        if (Script.redelivers(found.story)) {
          unrun++;
          continue;
        }
        // Two things a report shows are often the same sequence: it is run once.
        const text = Script.script(found.story);
        if (ran.has(text)) continue;
        ran.add(text);
        const result = yield* Effect.suspend(() => story(...stepsOf(model, found.story))).pipe(
          Effect.result,
        );
        if (found.walk) walked++;
        runs.push({
          of: found.of,
          story: found.story,
          failure: Result.isSuccess(result)
            ? undefined
            : String((result.failure as { readonly message?: unknown }).message ?? result.failure),
        });
      }
    }
    const rules = rulesOf(explored);
    const made: Report = {
      model: model.modelName,
      rules,
      explored,
      runs,
      walked,
      unrun,
      undone: [
        ...Explore.undone(explored, options.allow ?? {}),
        ...required(rules, options.require),
      ],
      // Only a model with a decision takes its commit for granted.
      assumptions: explored.decisions.length > 0 ? [...ASSUMPTIONS, Prove.ATOMIC] : ASSUMPTIONS,
    };
    return made;
  });
};

/** Whether a report verifies the model: no rule is broken, every run agrees, and nothing was left undone. */
export const verified = (report: Report): boolean =>
  report.rules.every((rule) => rule.standing !== "broken") &&
  report.runs.every((run) => run.failure === undefined) &&
  report.undone.length === 0;

/**
 * Verify a model, or fail with the report: a rule is broken, a sequence the
 * explorer found does not run on the real model, or part of the check was
 * not done.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("the bank keeps its promises", () =>
 *   Verify.model(Bank, { apis: [CustomerApi, SupportApi] }).pipe(
 *     Effect.provide(NodeServices.layer),
 *   ),
 * );
 * ```
 *
 * **Example:** Running what it finds on the real model
 * ```typescript
 * const story = Story.make(Bank, { layer: BankHandlers, stub: [FraudCheck, Payments] });
 *
 * it.effect("the bank keeps its promises", () =>
 *   Verify.model(Bank, { apis: [CustomerApi, SupportApi], story }).pipe(
 *     Effect.provide(NodeServices.layer),
 *   ),
 * );
 * ```
 */
export const model = (
  target: Model.Any,
  options: Options,
): Effect.Effect<Report, VerifyError | NotVerified, Requirements> =>
  report(target, options).pipe(
    Effect.flatMap((made) =>
      verified(made)
        ? Effect.succeed(made)
        : Effect.fail(new NotVerified({ message: `\n${render(made)}`, report: made })),
    ),
  );

export interface AggregateOptions {
  /**
   * The file the aggregate is declared in. Left out, it is found from the
   * test file that calls.
   */
  readonly source?: URL | string;
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
  /** What a pass may leave undone. */
  readonly allow?: Explore.Options["allow"];
  /**
   * How far a rule has to be known to hold, for the rules named: a rule in
   * `proved` that is only checked fails the verification.
   */
  readonly require?: Require;
}

/** Why a rule no sequence breaks is not proved. */
export interface Unproved {
  readonly command: string;
  readonly verdict: Prove.Verdict;
}

export interface AggregateReport {
  readonly aggregate: string;
  /** Its invariants and transitions, and how far each is known to hold. */
  readonly rules: ReadonlyArray<
    Omit<Rule, "story" | "unproved"> & {
      /**
       * For a rule that is checked and not proved: the command the proof
       * fails on. A proof starts from any state the rules allow, so it can
       * fail on a state no sequence of commands reaches.
       */
      readonly unproved: Unproved | undefined;
    }
  >;
  readonly proof: Prove.Report;
  readonly explored: Explore.Report;
  /** Each part of the check that was not done. */
  readonly undone: ReadonlyArray<string>;
}

/** An aggregate's rule is broken, or part of the check was not done. */
export class AggregateNotVerified extends Data.TaggedError("NotVerified")<{
  readonly message: string;
  readonly report: AggregateReport;
}> {}

const renderAggregate = (report: AggregateReport): string => {
  const out: Array<string> = [
    `${report.aggregate}: ${report.rules.length} rules, ${report.proof.commands.length} commands`,
    "",
  ];
  const proved = report.rules.filter((rule) => rule.standing === "proved");
  if (proved.length > 0)
    out.push(
      "Proved: for every state and every input, after any number of commands",
      ...proved.map((rule) => `  ✓ ${rule.name}`),
      "",
    );
  const checked = report.rules.filter((rule) => rule.standing === "checked");
  if (checked.length > 0)
    out.push(
      `Checked: in every sequence of up to ${report.explored.depth} commands on a new instance`,
      ...checked.flatMap((rule) => {
        const why = rule.unproved;
        if (!why) return [`  ✓ ${rule.name}`];
        const verdict = why.verdict;
        return [
          `  ✓ ${rule.name}`,
          ...(verdict._tag === "Violated"
            ? [
                `      not proved: ${Symbolic.show(verdict.counterexample.command)} breaks it from ${Symbolic.show(verdict.counterexample.state)}, a state the rules allow`,
                "      No sequence that was run reaches that state. If none can, say so in an invariant, and this one is proved.",
              ]
            : [
                `      not proved for ${why.command}: ${verdict._tag === "Proved" ? "" : "reason" in verdict ? verdict.reason : ""}`,
              ]),
        ];
      }),
      "",
    );
  const broken = report.rules.filter((rule) => rule.standing === "broken");
  if (broken.length > 0) out.push(...broken.map((rule) => `✗ ${rule.name} breaks`), "");
  if (report.undone.length > 0)
    out.push("Not done", ...report.undone.map((reason) => `  ✗ ${reason}`), "");
  if (report.proof.unkept.length > 0)
    out.push(
      "Schema checks not proved kept",
      ...report.proof.unkept.map((line) => `  - ${line}`),
      "",
    );
  if (broken.length > 0 || report.undone.length > 0)
    out.push(Prove.render(report.proof), "", Explore.render(report.explored));
  return out.join("\n");
};

/**
 * Verify one aggregate: prove each invariant and transition for every state
 * and every input, and search every sequence of a few commands for one that
 * breaks a rule the solver could not decide. It fails with the report when a
 * rule is broken or part of the check was not done.
 *
 * **Example:** In a test
 * ```typescript
 * it.effect("an account keeps its rules", () =>
 *   Verify.aggregate(Account).pipe(Effect.provide(NodeServices.layer)),
 * );
 * ```
 */
export const aggregate = (
  target: Aggregate.Any,
  options: AggregateOptions = {},
): Effect.Effect<AggregateReport, VerifyError | AggregateNotVerified, Requirements> => {
  // The call stack is read here, while the test that calls is still on it.
  const from = callers(new Error("caller").stack, OWN);
  return Effect.gen(function* () {
    const source = options.source ?? (yield* locate(target.aggregateName, "Aggregate", from));
    const failed = (error: { readonly message: string }) =>
      new VerifyError({ message: error.message });
    const proof = yield* Prove.report(target, { source }).pipe(Effect.mapError(failed));
    const explored = yield* Explore.report(target, {
      source,
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    }).pipe(Effect.mapError(failed));
    const rules: AggregateReport["rules"] = explored.invariants.map((rule) => {
      const verdicts = [...proof.invariants, ...proof.transitions].find(
        (proved) => proved.name === rule.name,
      )?.commands;
      const failing = verdicts?.find((command) => command.verdict._tag !== "Proved");
      return {
        name: rule.name,
        kind: rule.kind,
        standing: rule.broken
          ? "broken"
          : rule.proved
            ? "proved"
            : rule.states > 0
              ? "checked"
              : "unseen",
        seen: rule.states,
        unproved:
          rule.broken || rule.proved || !failing
            ? undefined
            : { command: failing.command, verdict: failing.verdict },
      };
    });
    const made: AggregateReport = {
      aggregate: target.aggregateName,
      rules,
      proof,
      explored,
      undone: [
        ...Explore.undone(explored, options.allow ?? {}),
        ...required(rules, options.require),
      ],
    };
    return made.rules.some((rule) => rule.standing === "broken") || made.undone.length > 0
      ? yield* new AggregateNotVerified({ message: `\n${renderAggregate(made)}`, report: made })
      : made;
  });
};

const indent = (text: string, by: string): ReadonlyArray<string> =>
  text.split("\n").map((line) => `${by}${line}`);

/** A report as text: what is proved, what is checked, what is broken and what is assumed. */
export const render = (report: Report | AggregateReport): string => {
  if ("aggregate" in report) return renderAggregate(report);
  const explored = report.explored;
  const some = (n: number, one: string, many: string) =>
    n === 0 ? [] : [`${n} ${n === 1 ? one : many}`];
  const parts = [
    ...some(explored.outcomes.length, "outcome", "outcomes"),
    ...some(explored.decisions.length, "decision", "decisions"),
    ...some(explored.followed.length + explored.idle.length, "policy", "policies"),
    ...some(explored.sagas.length + explored.unstarted.length, "saga", "sagas"),
    ...some(explored.views.length, "view", "views"),
    ...some(explored.projections.length, "projection", "projections"),
    ...some(explored.systems.length, "external system", "external systems"),
  ];
  const out: Array<string> = [`${report.model}: ${parts.join(", ")}`, ""];
  const named = (rules: ReadonlyArray<Rule>) => rules.map((rule) => `  ✓ ${rule.name}`);

  const proved = report.rules.filter((rule) => rule.standing === "proved");
  if (proved.length > 0)
    out.push(
      "Proved: for every state and every input, after any number of commands",
      ...named(proved),
      "",
    );

  const faults = [
    ...(explored.faults.redeliver ? ["each event delivered twice"] : []),
    ...(explored.faults.reorder ? ["each reaction also run behind the others that wait"] : []),
    ...(explored.faults.rerun && explored.sagas.length + explored.unstarted.length > 0
      ? ["each step of a saga run twice"]
      : []),
    ...(explored.systems.length > 0
      ? [`every answer ${explored.systems.join(" and ")} can give`]
      : []),
  ];
  const checked = report.rules.filter((rule) => rule.standing === "checked");
  if (checked.length > 0)
    out.push(
      `Checked: in every sequence of up to ${explored.depth} ${explored.depth === 1 ? "command" : "commands"} through ${explored.apis.join(", ")}${
        faults.length > 0 ? `, with ${faults.join(", ")}` : ""
      }`,
      `${count(explored.sequences)} sequences, ${count(explored.states)} states`,
      ...checked.flatMap((rule) => {
        if (rule.kind === "eventually")
          return [
            `  ✓ ${rule.name}  holds at the end of the ${count(rule.seen)} sequences that ran their course`,
          ];
        const why = rule.unproved;
        if (!why) return [`  ✓ ${rule.name}`];
        const verdict = why.verdict;
        return [
          `  ✓ ${rule.name}`,
          ...(verdict._tag === "Violated"
            ? [
                verdict.counterexample.command === undefined
                  ? `      not proved: it does not hold of ${Symbolic.show(verdict.counterexample.state)}, in a model with nothing in it`
                  : `      not proved: ${Symbolic.show(verdict.counterexample.command)} breaks it from ${Symbolic.show(verdict.counterexample.state)}, states the rules allow`,
                "      No sequence that was run reaches those states. If none can, say so in another relation or an invariant, and this one is proved.",
              ]
            : [`      not proved for ${why.by}: ${"reason" in verdict ? verdict.reason : ""}`]),
        ];
      }),
      "",
    );

  const broken = report.rules.filter((rule) => rule.standing === "broken");
  if (explored.walks.count > 0)
    out.push(
      `Sampled: ${count(explored.walks.count)} longer sequences, of up to ${explored.walks.longest} commands picked at random (seed ${explored.walks.seed})`,
      ...(broken.length === 0 ? ["  ✓ none breaks a rule"] : []),
      "",
    );

  for (const rule of broken) {
    out.push(
      rule.kind === "eventually"
        ? `✗ ${rule.name} does not hold in the end`
        : `✗ ${rule.name} breaks`,
    );
    if (!rule.story || rule.story.length === 0) {
      out.push("    on a new instance", "");
      continue;
    }
    out.push(Explore.describe(rule.story, "    "), "");
    if (Script.redelivers(rule.story))
      out.push(
        "    It needs an event delivered twice, a step run twice or a schedule that runs late: a platform does each, and a story does not.",
        "",
      );
    else
      out.push(
        "    As a story, to keep as a test:",
        "",
        ...indent(Script.script(rule.story), "    "),
        "",
      );
  }

  const unseen = report.rules.filter((rule) => rule.standing === "unseen");
  if (unseen.length > 0)
    out.push(
      "Not looked at: no sequence reached it",
      ...unseen.map((rule) => `  ? ${rule.name}`),
      "",
    );

  if (report.runs.length > 0) {
    const failed = report.runs.filter((run) => run.failure !== undefined);
    out.push(
      `Run on the real model: ${count(report.runs.length - report.walked)} sequences the explorer found${
        report.walked > 0 ? ` and ${count(report.walked)} walks of commands picked at random` : ""
      }, as stories${
        report.unrun > 0
          ? ` (${count(report.unrun)} more need an event delivered twice, a step run twice or a schedule that runs late, which a story does not do)`
          : ""
      }`,
      failed.length === 0
        ? "  ✓ the model does what the explorer read in each"
        : `  ✗ the model does something else in ${count(failed.length)}`,
    );
    for (const run of failed)
      out.push(
        "",
        `  ✗ ${run.of}`,
        ...indent(Script.script(run.story), "      "),
        ...indent(run.failure!.trim(), "      "),
      );
    out.push("");
  }

  if (report.undone.length > 0)
    out.push("Not done", ...report.undone.map((reason) => `  ✗ ${reason}`), "");

  if (explored.repeated.length > 0)
    out.push(
      "Called again when an event is delivered again: each has to be safe to repeat",
      ...explored.repeated.map((call) => `  ${call}`),
      "",
    );

  if (explored.unkept.length > 0)
    out.push("Schema checks not proved kept", ...explored.unkept.map((line) => `  - ${line}`), "");

  if (explored.aside.length > 0)
    out.push(
      "Left out, and no rule depends on it",
      ...explored.aside.map((left) => `  - ${left.kind} ${left.name}: ${left.reason}`),
      "",
    );

  out.push("Assumed", ...report.assumptions.map((assumption) => `  - ${assumption}`));
  return out.join("\n");
};
