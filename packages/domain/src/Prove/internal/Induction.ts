import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Aggregate from "../../Aggregate.ts";
import type * as Decision from "../../Decision.ts";
import type { Verdict } from "./Check.ts";
import * as Check from "./Check.ts";
import type { Interpreter } from "./Interpreter.ts";
import * as Paths from "./Paths.ts";
import type * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
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
  /**
   * What the command writes to a part of the state whose schema has a check
   * the prover does not read: the new value is not proved to pass it.
   */
  readonly unkept: ReadonlyArray<string>;
}

/** The checks of the state's schema no proof covers, as lines of a report. */
export const unkept = (rows: ReadonlyArray<Row>): ReadonlyArray<string> =>
  rows.flatMap((row) =>
    row.unkept.map(
      (line) => `${line}: the prover does not read that check, so it is not proved kept`,
    ),
  );

/** Whether every command keeps the state in its schema, so that the proofs follow one another. */
export const closed = (rows: ReadonlyArray<Row>): boolean =>
  rows.every((row) => row.fits._tag === "Proved");

const RANK = {
  Proved: 0,
  Bounded: 1,
  Unknown: 2,
  NotTranslated: 3,
  Unconfirmed: 4,
  Violated: 5,
} as const;

/**
 * What a proof on one path is worth: where the path gave a list only a few
 * items, it says nothing of a longer one.
 */
export const within = (verdict: Verdict, run: Value.Run): Verdict =>
  verdict._tag !== "Proved" || run.bounds.size === 0
    ? verdict
    : {
        _tag: "Bounded",
        reason: [...run.bounds]
          .map(([name, most]) => `${name} was tried with up to ${most} items`)
          .join(", "),
      };

export const worse = (a: Verdict, b: Verdict): Verdict => (RANK[b._tag] > RANK[a._tag] ? b : a);

export const notRead = (error: Value.NotTranslated): Verdict => ({
  _tag: "NotTranslated",
  file: error.file,
  line: error.line,
  reason: error.reason,
});

export const MAX_PATHS = 4096;

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
  const names = Paths.ruleNames(definition);
  const made: Array<Row> = [];
  for (const cls of aggregate.definition.commands) {
    const command = cls as unknown as Paths.CommandClass;
    const verdicts = new Map<string, Verdict>(names.map((name) => [name, { _tag: "Proved" }]));
    const all = (verdict: Verdict) => {
      for (const name of names) verdicts.set(name, worse(verdicts.get(name)!, verdict));
    };
    let fits: Verdict = { _tag: "Proved" };
    const unkept = new Set<string>();
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
      // A path that gave a list only a few items says nothing of a longer one,
      // whatever it found: not that the command keeps a rule, nor that it does nothing.
      if (taken.run.bounds.size > 0) {
        const short = within({ _tag: "Proved" }, taken.run);
        all(short);
        fits = worse(fits, short);
        accepted ||= undefined;
      }
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
        verdicts.set(check.name, worse(verdicts.get(check.name)!, within(verdict, taken.run)));
      }
      const fitting = yield* Check.check(
        solver,
        aggregate,
        Check.schema(aggregate),
        taken.run,
        taken.inputs,
        outcome.fits,
      );
      fits = worse(fits, within(fitting, taken.run));
      // A part the command writes, with a check the prover does not read: nothing
      // says the new value passes it. The proofs never assume such a check, so
      // they stand; the report says the check is not proved kept.
      for (const check of outcome.unread)
        unkept.add(`${command.tag} writes ${check.at}, which has to be ${check.check}`);
      if (accepted !== true) {
        // Any inputs at all that take this path: the command can record an event.
        const taking = yield* Check.solve(solver, taken.run, "false");
        accepted = taking._tag === "Sat" ? true : taking._tag === "Unknown" ? undefined : accepted;
      }
    }
    made.push({ command: command.tag, paths, verdicts, fits, accepted, unkept: [...unkept] });
  }
  return made;
});

/** A decision the prover reads: its definition, and each aggregate it reads with its own. */
export interface DecisionImpl {
  readonly cls: Decision.Any;
  readonly definition: Paths.DecisionDefinition;
  readonly command: Paths.CommandClass;
  readonly reads: Readonly<
    Record<string, { readonly cls: Aggregate.Any; readonly definition: Paths.Definition }>
  >;
}

/** The name a report gives an aggregate's rule that a decision must keep. */
export const ruleOf = (aggregate: string, name: string): string => `${aggregate}.${name}`;

/**
 * What one decision does to every rule of every aggregate it reads, and to
 * its own, from any states the schemas allow.
 */
export interface DecisionRow extends Row {
  /** The decision's own transitions, by name: the other verdicts are named `Aggregate.Rule`. */
  readonly own: ReadonlyArray<string>;
}

/**
 * The instances a decision reads on one path, each given any state its
 * aggregate's rules allow the first time `keyOf` names it. Two names of one
 * aggregate are the same instance on one path and two on another.
 */
export const reader = (interpreter: Interpreter, impl: DecisionImpl, run: Value.Run) => {
  const site: Value.Site = { module: impl.definition.module, node: impl.definition.node };
  const read: Array<{ readonly cls: Aggregate.Any; readonly slot: Paths.Slot }> = [];
  const slotOf = Effect.fnUntraced(function* (name: string, id: Value.V) {
    const found = impl.reads[name];
    if (!found)
      return yield* Value.notTranslated(site, `keyOf gives ${name}, which reads does not name`);
    const text = Paths.addressOf(id)!;
    for (const [index, existing] of read.entries()) {
      if (existing.cls !== found.cls) continue;
      const other = Paths.addressOf(existing.slot.id)!;
      if (text === other) return { index, slot: existing.slot };
      if (id._tag === "Str" && existing.slot.id._tag === "Str") continue;
      // Two names of one aggregate: the same instance, or two.
      if (run.branch(`(= ${text} ${other})`)) return { index, slot: existing.slot };
    }
    const at = read.length + 1;
    // Assume: the state the decision reads satisfies every invariant of its aggregate.
    const state = yield* Paths.assumed(interpreter, found.definition, `read${at}.state`);
    const version = run.constant(`read${at}.version`, "Int");
    run.assume(`(>= ${version.text} 0)`);
    const slot: Paths.Slot = {
      definition: found.definition,
      id,
      state,
      version: { _tag: "Term", term: version },
    };
    read.push({ cls: found.cls, slot });
    return { index: read.length - 1, slot };
  });
  return { read, slotOf };
};

/**
 * Take a decision from any states that satisfy every invariant of the
 * aggregates it reads, along every path through its code, and say whether
 * each of their rules, and each of its own, still holds. Two names that can
 * stand for one instance are tried both ways: as two instances, and as one.
 */
export const decisionRow = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  impl: DecisionImpl,
) {
  const tag = impl.command.tag;
  /** Each aggregate the decision reads, once, with its definition. */
  const reads = Object.values(impl.reads).filter(
    (one, index, all) => all.findIndex((other) => other.cls === one.cls) === index,
  );
  const own = Paths.decisionRuleNames(impl.definition);
  const names = [
    ...reads.flatMap(({ cls, definition }) =>
      Paths.ruleNames(definition).map((name) => ruleOf(cls.aggregateName, name)),
    ),
    ...own,
  ];
  const verdicts = new Map<string, Verdict>(names.map((name) => [name, { _tag: "Proved" }]));
  const all = (verdict: Verdict) => {
    for (const name of names) verdicts.set(name, worse(verdicts.get(name)!, verdict));
  };
  let fits: Verdict = { _tag: "Proved" };
  const unkept = new Set<string>();
  let accepted: boolean | undefined = false;
  let paths = 0;
  let prefix: ReadonlyArray<number> | undefined = [];
  while (prefix) {
    if (++paths > MAX_PATHS) {
      const many: Verdict = { _tag: "Unknown", reason: `${tag} has more than ${MAX_PATHS} paths` };
      all(many);
      fits = worse(fits, many);
      accepted ||= undefined;
      break;
    }
    const run = new Value.Run(prefix);
    interpreter.current.run = run;
    const { read, slotOf } = reader(interpreter, impl, run);
    const taken = yield* Effect.gen(function* () {
      const step = yield* Paths.decided(interpreter, impl.definition, impl.command, "", slotOf);
      if (step.applied._tag !== "Changed") return { step, checks: [], fits: "true", unread: [] };
      const checks: Array<{
        readonly name: string;
        readonly kept: Check.DecisionKept;
        readonly condition: Paths.Check["condition"];
      }> = [];
      const fitting: Array<string> = [];
      const unread: Array<Symbolic.Unread> = [];
      for (const part of step.applied.parts) {
        const slot = step.slots[part.slot]!;
        const cls = read.find((one) => one.slot === slot)!.cls;
        for (const check of yield* Paths.checks(interpreter, slot.definition, part.state, {
          before: part.before,
          command: step.inputs.command,
          events: part.events,
        }))
          checks.push({
            name: ruleOf(cls.aggregateName, check.name),
            kept: Check.onInstance(cls, check.name, part.slot),
            condition: check.condition,
          });
        const ast = Symbolic.typeOf(slot.definition.state)!;
        fitting.push(Symbolic.fits(part.state, ast, run));
        unread.push(
          ...Symbolic.unread(slot.definition.state, `${cls.aggregateName} state`).filter(
            (check) =>
              !Paths.same(Paths.at(part.before, check.path), Paths.at(part.state, check.path)),
          ),
        );
      }
      for (const check of yield* Paths.decisionChecks(interpreter, impl.definition, step))
        checks.push({
          name: check.name,
          kept: Check.transition(impl.cls, check.name),
          condition: check.condition,
        });
      return {
        step,
        checks,
        fits:
          fitting.length === 0
            ? "true"
            : fitting.length === 1
              ? fitting[0]!
              : `(and ${fitting.join(" ")})`,
        unread,
      };
    }).pipe(
      Effect.map((made) => ({ _tag: "Ran", ...made }) as const),
      Effect.catchTags({
        Infeasible: () => Effect.succeed({ _tag: "Infeasible" } as const),
        NotTranslated: (error) => Effect.succeed({ _tag: "Stopped", error } as const),
        Rejected: () => Effect.succeed({ _tag: "Infeasible" } as const),
      }),
    );
    prefix = Value.nextPrefix(run.taken);
    // A path that gave a list only a few items says nothing of a longer one.
    if (run.bounds.size > 0) {
      const short = within({ _tag: "Proved" }, run);
      all(short);
      fits = worse(fits, short);
      accepted ||= undefined;
    }
    if (taken._tag === "Stopped") {
      const unread = notRead(taken.error);
      all(unread);
      fits = worse(fits, unread);
      accepted ||= undefined;
    }
    if (taken._tag !== "Ran" || taken.step.applied._tag !== "Changed") continue;
    const sorted = taken.step.slots.map((slot) => read.find((one) => one.slot === slot)!.cls);
    for (const check of taken.checks) {
      const verdict: Verdict = Result.isFailure(check.condition)
        ? notRead(check.condition.failure)
        : yield* Check.checkDecision(
            solver,
            impl.cls,
            sorted,
            check.kept,
            run,
            taken.step,
            check.condition.success,
          );
      verdicts.set(check.name, worse(verdicts.get(check.name)!, within(verdict, run)));
    }
    const fitting = yield* Check.checkDecision(
      solver,
      impl.cls,
      sorted,
      Check.schemas,
      run,
      taken.step,
      taken.fits,
    );
    fits = worse(fits, within(fitting, run));
    for (const check of taken.unread)
      unkept.add(`${tag} writes ${check.at}, which has to be ${check.check}`);
    if (accepted !== true) {
      const taking = yield* Check.solve(solver, run, "false");
      accepted = taking._tag === "Sat" ? true : taking._tag === "Unknown" ? undefined : accepted;
    }
  }
  const row: DecisionRow = {
    command: tag,
    paths,
    verdicts,
    fits,
    accepted,
    unkept: [...unkept],
    own,
  };
  return row;
});

/** Find a decision's definition, and each aggregate's it reads, among files that were read. */
export const locate = Effect.fn(function* (
  interpreter: Interpreter,
  modules: ReadonlyArray<Value.Module>,
  decision: Decision.Any,
) {
  const definition = yield* Paths.decisionIn(interpreter, modules, decision);
  if (!definition) return `the decision for ${decision.decisionName}`;
  const reads: Record<
    string,
    { readonly cls: Aggregate.Any; readonly definition: Paths.Definition }
  > = {};
  for (const [name, cls] of Object.entries(decision.reads)) {
    const found = Paths.aggregateIn(modules, cls);
    if (!found) return cls.aggregateName;
    reads[name] = { cls, definition: found };
  }
  const impl: DecisionImpl = {
    cls: decision,
    definition,
    command: decision.command as unknown as Paths.CommandClass,
    reads,
  };
  return impl;
});
