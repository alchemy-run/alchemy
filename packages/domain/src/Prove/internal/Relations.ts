import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Aggregate from "../../Aggregate.ts";
import type { Verdict } from "./Check.ts";
import * as Check from "./Check.ts";
import * as Induction from "./Induction.ts";
import type { Interpreter } from "./Interpreter.ts";
import * as Paths from "./Paths.ts";
import type * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import * as Value from "./Value.ts";

type V = Value.V;

/** An aggregate a relation is over, with where it is written and the state a new instance has. */
export interface Over {
  readonly cls: Aggregate.Any;
  readonly definition: Paths.Definition;
  readonly initial: V;
}

/** A relation the prover reads: the aggregate behind each of its names, and the real function. */
export interface Relation {
  readonly name: string;
  readonly over: Readonly<Record<string, Over>>;
  readonly real: (on: Readonly<Record<string, Real>>) => boolean;
}

/** One real instance a relation is given. */
export interface Real {
  readonly id: unknown;
  readonly state: unknown;
}

/** A model's relations, and everything that can change what they are about. */
export interface Subject {
  /** The model's definition, where its relations are written. */
  readonly model: Paths.Definition;
  readonly relations: ReadonlyArray<Relation>;
  readonly decisions: ReadonlyArray<Induction.DecisionImpl>;
}

/** How far one relation is proved, and what the proof fails on when it does. */
export interface Row {
  readonly name: string;
  readonly verdict: Verdict;
  /** What breaks it, or what the prover could not read: a command, a decision, or a new model. */
  readonly by: string | undefined;
  /** The relations the proof takes to hold before each step: itself and the others still standing. */
  readonly assumes: ReadonlyArray<string>;
}

/** One instance on a path: before a step, and after it where the step changed it. */
interface Inst {
  readonly cls: Aggregate.Any;
  readonly id: V;
  readonly state: V;
  readonly after: V;
}

/** Every way to give each name of a relation one of `present`, of its aggregate, no two the same. */
const assignments = (
  relation: Relation,
  present: ReadonlyArray<Inst>,
): ReadonlyArray<Readonly<Record<string, number>>> => {
  const names = Object.keys(relation.over);
  const made: Array<Record<string, number>> = [];
  const go = (at: number, chosen: Record<string, number>): void => {
    if (at === names.length) return void made.push({ ...chosen });
    const name = names[at]!;
    for (const [index, inst] of present.entries()) {
      if (inst.cls !== relation.over[name]!.cls || Object.values(chosen).includes(index)) continue;
      chosen[name] = index;
      go(at + 1, chosen);
      delete chosen[name];
    }
  };
  go(0, {});
  return made;
};

const and = (formulas: ReadonlyArray<string>): string =>
  formulas.length === 0
    ? "true"
    : formulas.length === 1
      ? formulas[0]!
      : `(and ${formulas.join(" ")})`;

/** A new instance on the current path: any id no other of its aggregate has, any state its rules allow. */
const fresh = (
  interpreter: Interpreter,
  over: Over,
  label: string,
  others: ReadonlyArray<Inst>,
): Value.Eval<Inst> =>
  Effect.gen(function* () {
    const run = interpreter.current.run;
    const id: V = { _tag: "Term", term: run.constant(`${label}.id`, "String") };
    for (const other of others)
      if (other.cls === over.cls)
        run.assume(`(not (= ${Paths.addressOf(id)!} ${Paths.addressOf(other.id)!}))`);
    const state = yield* Paths.assumed(interpreter, over.definition, `${label}.state`);
    return { cls: over.cls, id, state, after: state };
  });

/**
 * What a proof takes to hold before a step: every relation in `assumed`, on
 * every choice of the instances present. One the prover cannot read on a
 * choice is left out, which only weakens what is assumed.
 */
const before = (
  interpreter: Interpreter,
  subject: Subject,
  assumed: ReadonlySet<string>,
  present: ReadonlyArray<Inst>,
  cache: Map<string, string | undefined>,
): Value.Eval<{
  readonly formula: string;
  readonly uses: ReadonlyArray<{
    readonly relation: Relation;
    readonly on: Readonly<Record<string, number>>;
  }>;
}> =>
  Effect.gen(function* () {
    const formulas: Array<string> = [];
    const uses: Array<{ relation: Relation; on: Readonly<Record<string, number>> }> = [];
    for (const relation of subject.relations) {
      if (!assumed.has(relation.name)) continue;
      for (const on of assignments(relation, present)) {
        const key = `${relation.name}:${Object.entries(on)
          .map(([name, index]) => `${name}=${Paths.addressOf(present[index]!.id)}`)
          .join(",")}`;
        if (!cache.has(key))
          cache.set(
            key,
            yield* Paths.relationHolds(
              interpreter,
              subject.model,
              relation.name,
              Object.fromEntries(
                Object.entries(on).map(([name, index]) => [name, present[index]!]),
              ),
            ).pipe(Effect.catchTag("NotTranslated", () => Effect.succeed(undefined))),
          );
        const formula = cache.get(key);
        if (formula === undefined) continue;
        formulas.push(formula);
        uses.push({ relation, on });
      }
    }
    return { formula: and(formulas), uses };
  });

/** The real instances a relation is given, for one choice of them. */
const bound = (
  on: Readonly<Record<string, number>>,
  present: ReadonlyArray<Real>,
): Readonly<Record<string, Real>> =>
  Object.fromEntries(Object.entries(on).map(([name, index]) => [name, present[index]!]));

/** A real instance from the solver's answer: it fails when its state is not one its aggregate allows. */
const built = Effect.fn(function* (build: Check.Build, inst: Inst) {
  const id = yield* build("id", inst.id);
  const state = yield* build("state", inst.state);
  if (!Schema.is(inst.cls.definition.state)(state))
    return yield* Effect.fail(
      Check.notConfirmed(
        `the solver's state ${Symbolic.show(state)} is not one the schema of ${inst.cls.aggregateName} allows`,
      ),
    );
  const invariants = (inst.cls.definition.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
  for (const [name, holds] of Object.entries(invariants))
    if (!holds(state))
      return yield* Effect.fail(
        Check.notConfirmed(
          `the solver's state ${Symbolic.show(state)} already breaks ${inst.cls.aggregateName}.${name}, which the prover could not read`,
        ),
      );
  const real: Real = { id, state };
  return real;
});

/** Whether the real relations the proof assumed all hold of the real instances before the step. */
const assumedHold = (
  uses: ReadonlyArray<{
    readonly relation: Relation;
    readonly on: Readonly<Record<string, number>>;
  }>,
  present: ReadonlyArray<Real>,
): boolean => uses.every((use) => use.relation.real(bound(use.on, present)));

interface Tally {
  verdict: Verdict;
  by: string | undefined;
}

const note = (tally: Tally, verdict: Verdict, by: string): void => {
  const next = Induction.worse(tally.verdict, verdict);
  if (next !== tally.verdict) {
    tally.verdict = next;
    tally.by = by;
  }
};

/** A relation on a model with nothing in it: every instance in the state a new one has. */
const atStart = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  subject: Subject,
  relation: Relation,
  tally: Tally,
) {
  const by = "a model with nothing in it";
  let prefix: ReadonlyArray<number> | undefined = [];
  while (prefix) {
    const run = new Value.Run(prefix);
    interpreter.current.run = run;
    const present: Array<Inst> = [];
    for (const [name, over] of Object.entries(relation.over)) {
      const id: V = { _tag: "Term", term: run.constant(`${name}.id`, "String") };
      for (const other of present)
        if (other.cls === over.cls)
          run.assume(`(not (= ${Paths.addressOf(id)!} ${Paths.addressOf(other.id)!}))`);
      present.push({ cls: over.cls, id, state: over.initial, after: over.initial });
    }
    const on = Object.fromEntries(Object.keys(relation.over).map((name, index) => [name, index]));
    const condition = yield* Paths.relationHolds(
      interpreter,
      subject.model,
      relation.name,
      Object.fromEntries(Object.entries(on).map(([name, index]) => [name, present[index]!])),
    ).pipe(Effect.result);
    prefix = Value.nextPrefix(run.taken);
    if (Result.isFailure(condition)) {
      if (condition.failure._tag === "NotTranslated")
        note(tally, Induction.notRead(condition.failure), by);
      continue;
    }
    note(
      tally,
      yield* Check.checkAt(solver, run, condition.success, (build) =>
        Effect.gen(function* () {
          const real: Array<Real> = [];
          for (const inst of present)
            real.push({ id: yield* build("id", inst.id), state: inst.cls.definition.initial });
          const state = bound(on, real);
          if (relation.real(state))
            return Check.notConfirmed(
              `the solver found ids for which a new model breaks ${relation.name}, but the real code keeps it on them`,
            );
          const verdict: Verdict = {
            _tag: "Violated",
            counterexample: {
              state,
              command: undefined,
              context: [],
              now: DateTime.makeUnsafe(0),
              events: [],
              after: state,
            },
          };
          return verdict;
        }),
      ),
      by,
    );
  }
});

/** A relation across one command of one of its aggregates, sent to the instance under `name`. */
const acrossCommand = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  subject: Subject,
  assumed: ReadonlySet<string>,
  relation: Relation,
  name: string,
  command: Paths.CommandClass,
  tally: Tally,
) {
  const over = relation.over[name]!;
  const by = `${over.cls.aggregateName}.${command.tag}`;
  const names = Object.keys(relation.over);
  const at = names.indexOf(name);
  let paths = 0;
  let prefix: ReadonlyArray<number> | undefined = [];
  while (prefix) {
    if (++paths > Induction.MAX_PATHS) {
      note(
        tally,
        { _tag: "Unknown", reason: `${by} has more than ${Induction.MAX_PATHS} paths` },
        by,
      );
      break;
    }
    const run = new Value.Run(prefix);
    interpreter.current.run = run;
    const present: Array<Inst> = [];
    const taken = yield* Effect.gen(function* () {
      for (const other of names)
        present.push(yield* fresh(interpreter, relation.over[other]!, other, present));
      const assumption = yield* before(interpreter, subject, assumed, present, new Map());
      const version = run.constant("version", "Int");
      run.assume(`(>= ${version.text} 0)`);
      const stepped = yield* Paths.step(
        interpreter,
        over.definition,
        command,
        present[at]!.state,
        { _tag: "Term", term: version },
        "",
        { id: present[at]!.id },
      );
      if (stepped.applied._tag !== "Changed") return undefined;
      const after = present.map((inst, index) =>
        index === at && stepped.applied._tag === "Changed"
          ? { ...inst, state: stepped.applied.state }
          : inst,
      );
      const holds = yield* Paths.relationHolds(
        interpreter,
        subject.model,
        relation.name,
        Object.fromEntries(names.map((other, index) => [other, after[index]!])),
      );
      return { assumption, stepped, condition: `(=> ${assumption.formula} ${holds})` };
    }).pipe(
      Effect.map((made) => ({ _tag: "Ran", made }) as const),
      Effect.catchTags({
        Infeasible: () => Effect.succeed({ _tag: "Infeasible" } as const),
        NotTranslated: (error) => Effect.succeed({ _tag: "Stopped", error } as const),
        Rejected: () => Effect.succeed({ _tag: "Infeasible" } as const),
      }),
    );
    prefix = Value.nextPrefix(run.taken);
    if (run.bounds.size > 0) note(tally, Induction.within({ _tag: "Proved" }, run), by);
    if (taken._tag === "Stopped") note(tally, Induction.notRead(taken.error), by);
    if (taken._tag !== "Ran" || !taken.made) continue;
    const { assumption, stepped, condition } = taken.made;
    const on = Object.fromEntries(names.map((other, index) => [other, index]));
    const verdict = yield* Check.check(
      solver,
      over.cls,
      (build) =>
        Effect.gen(function* () {
          const real: Array<Real> = [];
          for (const [index, inst] of present.entries())
            real.push(
              index === at
                ? { id: yield* build("id", inst.id), state: undefined }
                : yield* built(build, inst),
            );
          const states = (state: unknown): ReadonlyArray<Real> =>
            real.map((one, index) => (index === at ? { id: one.id, state } : one));
          const kept: Check.Kept = {
            what: relation.name,
            holds: (moved) =>
              !assumedHold(assumption.uses, states(moved.before)) ||
              relation.real(bound(on, states(moved.after))),
            shown: (moved) => ({
              state: bound(on, states(moved.before)),
              after: bound(on, states(moved.after)),
            }),
          };
          return kept;
        }),
      run,
      stepped.inputs,
      condition,
    );
    note(tally, Induction.within(verdict, run), by);
  }
});

/** A relation across one decision that records on one of its aggregates. */
const acrossDecision = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  subject: Subject,
  assumed: ReadonlySet<string>,
  relation: Relation,
  impl: Induction.DecisionImpl,
  tally: Tally,
) {
  const by = impl.command.tag;
  const names = Object.keys(relation.over);
  let paths = 0;
  let prefix: ReadonlyArray<number> | undefined = [];
  while (prefix) {
    if (++paths > Induction.MAX_PATHS) {
      note(
        tally,
        { _tag: "Unknown", reason: `${by} has more than ${Induction.MAX_PATHS} paths` },
        by,
      );
      break;
    }
    const run = new Value.Run(prefix);
    interpreter.current.run = run;
    const { read, slotOf } = Induction.reader(interpreter, impl, run);
    const stepped = yield* Paths.decided(
      interpreter,
      impl.definition,
      impl.command,
      "",
      slotOf,
    ).pipe(
      Effect.map((step) => ({ _tag: "Ran", step }) as const),
      Effect.catchTags({
        Infeasible: () => Effect.succeed({ _tag: "Infeasible" } as const),
        NotTranslated: (error) => Effect.succeed({ _tag: "Stopped", error } as const),
        Rejected: () => Effect.succeed({ _tag: "Infeasible" } as const),
      }),
    );
    if (stepped._tag === "Stopped") note(tally, Induction.notRead(stepped.error), by);
    if (stepped._tag !== "Ran" || stepped.step.applied._tag !== "Changed") {
      prefix = Value.nextPrefix(run.taken);
      if (run.bounds.size > 0) note(tally, Induction.within({ _tag: "Proved" }, run), by);
      continue;
    }
    const step = stepped.step;
    const applied = stepped.step.applied;
    const sorted = step.slots.map((slot) => read.find((one) => one.slot === slot)!.cls);
    /** The instances the decision read, before it and after. */
    const slots: ReadonlyArray<Inst> = step.slots.map((slot, index) => ({
      cls: sorted[index]!,
      id: slot.id,
      state: slot.state,
      after: applied.parts.find((part) => part.slot === index)?.state ?? slot.state,
    }));
    const changed = new Set(applied.parts.map((part) => part.slot));
    /** Each name is one of the instances the decision read, or one it did not: `-1`. */
    const choices: Array<Readonly<Record<string, number>>> = [];
    const choose = (at: number, chosen: Record<string, number>): void => {
      if (at === names.length) {
        if (Object.values(chosen).some((index) => changed.has(index))) choices.push({ ...chosen });
        return;
      }
      const name = names[at]!;
      for (const index of [-1, ...slots.keys()]) {
        if (index >= 0 && slots[index]!.cls !== relation.over[name]!.cls) continue;
        if (index >= 0 && Object.values(chosen).includes(index)) continue;
        chosen[name] = index;
        choose(at + 1, chosen);
        delete chosen[name];
      }
    };
    choose(0, {});
    const cache = new Map<string, string | undefined>();
    const checks: Array<{
      readonly present: ReadonlyArray<Inst>;
      readonly on: Readonly<Record<string, number>>;
      readonly uses: Effect.Success<ReturnType<typeof before>>["uses"];
      readonly condition: string;
    }> = [];
    const prepared = yield* Effect.gen(function* () {
      for (const [number, choice] of choices.entries()) {
        const present: Array<Inst> = [...slots];
        const on: Record<string, number> = {};
        for (const name of names) {
          if (choice[name]! >= 0) {
            on[name] = choice[name]!;
            continue;
          }
          present.push(
            yield* fresh(interpreter, relation.over[name]!, `other${number}.${name}`, present),
          );
          on[name] = present.length - 1;
        }
        const assumption = yield* before(interpreter, subject, assumed, present, cache);
        const holds = yield* Paths.relationHolds(
          interpreter,
          subject.model,
          relation.name,
          Object.fromEntries(
            names.map((name) => {
              const inst = present[on[name]!]!;
              return [name, { id: inst.id, state: inst.after }];
            }),
          ),
        );
        checks.push({
          present,
          on,
          uses: assumption.uses,
          condition: `(=> ${assumption.formula} ${holds})`,
        });
      }
    }).pipe(
      Effect.as({ _tag: "Ran" } as const),
      Effect.catchTags({
        Infeasible: () => Effect.succeed({ _tag: "Infeasible" } as const),
        NotTranslated: (error) => Effect.succeed({ _tag: "Stopped", error } as const),
        Rejected: () => Effect.succeed({ _tag: "Infeasible" } as const),
      }),
    );
    prefix = Value.nextPrefix(run.taken);
    if (run.bounds.size > 0) note(tally, Induction.within({ _tag: "Proved" }, run), by);
    if (prepared._tag === "Stopped") note(tally, Induction.notRead(prepared.error), by);
    if (prepared._tag !== "Ran") continue;
    for (const check of checks) {
      const verdict = yield* Check.checkDecision(
        solver,
        impl.cls,
        sorted,
        (build) =>
          Effect.gen(function* () {
            const real: Array<Real> = [];
            for (const inst of check.present) real.push(yield* built(build, inst));
            const states = (moved: Check.DecisionMoved, which: "before" | "after") =>
              real.map((one, index): Real => {
                const stream = moved.streams[index];
                const wrote = moved.ran.wrote.find((wrote) => wrote.stream === stream);
                return wrote ? { id: one.id, state: wrote[which] } : one;
              });
            const kept: Check.DecisionKept = {
              what: relation.name,
              holds: (moved) =>
                !assumedHold(check.uses, states(moved, "before")) ||
                relation.real(bound(check.on, states(moved, "after"))),
              shown: (moved) => ({
                state: bound(check.on, states(moved, "before")),
                after: bound(check.on, states(moved, "after")),
              }),
            };
            return kept;
          }),
        run,
        step,
        check.condition,
      );
      note(tally, Induction.within(verdict, run), by);
    }
  }
});

/** Each relation in `assumed`, taking every one of them to hold before each step. */
const round = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  subject: Subject,
  assumed: ReadonlySet<string>,
) {
  const rows: Array<Row> = [];
  for (const relation of subject.relations) {
    if (!assumed.has(relation.name)) continue;
    const tally: Tally = { verdict: { _tag: "Proved" }, by: undefined };
    yield* atStart(solver, interpreter, subject, relation, tally);
    const classes = new Set(Object.values(relation.over).map((over) => over.cls));
    for (const [name, over] of Object.entries(relation.over))
      for (const command of over.cls.definition.commands ?? [])
        yield* acrossCommand(
          solver,
          interpreter,
          subject,
          assumed,
          relation,
          name,
          command as unknown as Paths.CommandClass,
          tally,
        );
    for (const impl of subject.decisions)
      if (Object.values(impl.reads).some((read) => classes.has(read.cls)))
        yield* acrossDecision(solver, interpreter, subject, assumed, relation, impl, tally);
    rows.push({ name: relation.name, verdict: tally.verdict, by: tally.by, assumes: [...assumed] });
  }
  return rows;
});

/**
 * How far each of a model's relations is proved. A proof of one takes every
 * relation to hold before each step, so they are proved together: one that
 * fails is taken out, and the rest are proved again without it, until those
 * left all stand.
 */
export const rows = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  subject: Subject,
) {
  const readable = new Set(Paths.relationNames(subject.model));
  const failed = new Map<string, Row>();
  let standing = new Set(subject.relations.map((r) => r.name).filter((name) => readable.has(name)));
  for (;;) {
    const made = yield* round(solver, interpreter, subject, standing);
    const broken = made.filter((row) => row.verdict._tag !== "Proved");
    if (broken.length === 0)
      return subject.relations.flatMap((relation): ReadonlyArray<Row> => {
        const row = made.find((row) => row.name === relation.name) ?? failed.get(relation.name);
        return row ? [row] : [];
      });
    for (const row of broken) failed.set(row.name, row);
    standing = new Set([...standing].filter((name) => !failed.has(name)));
  }
});
