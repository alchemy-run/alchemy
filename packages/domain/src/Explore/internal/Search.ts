import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import * as Check from "../../Prove/internal/Check.ts";
import * as Induction from "../../Prove/internal/Induction.ts";
import type { Interpreter } from "../../Prove/internal/Interpreter.ts";
import * as Paths from "../../Prove/internal/Paths.ts";
import * as Smt from "../../Prove/internal/Smt.ts";
import * as Symbolic from "../../Prove/internal/Symbolic.ts";
import type { V } from "../../Prove/internal/Value.ts";
import * as Value from "../../Prove/internal/Value.ts";

/** One command of a story, with what the real code did with it. */
export interface Move {
  readonly command: unknown;
  /** What each request context the command read held. */
  readonly context: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
  readonly now: DateTime.Utc;
  readonly outcome:
    | {
        readonly _tag: "Accepted";
        readonly events: ReadonlyArray<unknown>;
        readonly state: unknown;
      }
    | { readonly _tag: "Rejected"; readonly rejection: unknown };
}

/** Commands sent one after another to a new instance. */
export type Story = ReadonlyArray<Move>;

/** Something a command can do: record an event, or refuse with a rejection. */
export interface Outcome {
  readonly command: string;
  readonly kind: "records" | "rejects";
  readonly tag: string;
  /** The shortest story found that ends in it. */
  readonly story: Story | undefined;
}

export interface Found {
  /** The command sequences run, one per path through the code. */
  readonly sequences: number;
  /** The states whose invariants were checked. */
  readonly states: number;
  /** Whether the search stopped at its budget before every sequence was run. */
  readonly truncated: boolean;
  /** The most commands in a sequence for which every sequence was run. */
  readonly complete: number;
  readonly invariants: ReadonlyArray<{
    readonly name: string;
    /** The shortest story found that breaks it: no commands when a new instance does. */
    readonly broken: Story | undefined;
    /**
     * Whether no command can break it, whatever state the command meets: it
     * then holds after any number of commands, not only the ones run here.
     */
    readonly proved: boolean;
    /** The states reached in which it was looked at. */
    readonly states: number;
  }>;
  /**
   * The commands no state the invariants allow accepts: they never record an
   * event, so nothing said here is about them.
   */
  readonly dead: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly reached: ReadonlyArray<{ readonly tag: string; readonly story: Story | undefined }>;
  /** Code the explorer could not read: sequences through it were not run. */
  readonly unread: ReadonlyArray<Value.NotTranslated>;
  /** Sequences the solver found that the real code does not follow. */
  readonly disagreements: ReadonlyArray<string>;
  /** Why the solver gave up on a question, and how many times. */
  readonly undecided: ReadonlyArray<{ readonly reason: string; readonly times: number }>;
}

/** The real code does something else than the explorer read. */
class Disagreement extends Data.TaggedError("Disagreement")<{ readonly reason: string }> {}

interface CommandClass extends Paths.CommandClass {
  readonly events: ReadonlyArray<{ readonly tag: string }>;
  readonly rejects: ReadonlyArray<{ readonly tag: string }>;
}

interface Entry {
  readonly command: CommandClass;
  readonly label: string;
  readonly inputs: Paths.Inputs;
  readonly applied: Paths.Applied;
}

export const tagOf = (value: V): string | undefined => {
  const tag = value._tag === "Obj" ? value.fields._tag : undefined;
  return tag?._tag === "Str" ? tag.value : undefined;
};

/** A real value as the interpreter's: the initial state has no unknowns. */
export const lift = (value: unknown): V => {
  if (typeof value === "number") return Value.num(value);
  if (typeof value === "string") return Value.str(value);
  if (typeof value === "boolean") return Value.bool(value);
  if (value === null) return Value.nil;
  if (value === undefined) return Value.undef;
  if (DateTime.isDateTime(value)) {
    const millis = DateTime.toEpochMillis(value);
    return { _tag: "Time", millis: Smt.int(millis) };
  }
  if (Array.isArray(value)) return { _tag: "Arr", items: value.map(lift) };
  if (typeof value === "object")
    return Value.obj(
      Object.fromEntries(Object.entries(value).map(([key, field]) => [key, lift(field)])),
    );
  return { _tag: "Opaque", what: "the initial state" };
};

/** The `_tag` of each member of a state schema that is a union of tagged structs. */
export const stateTags = (schema: unknown): ReadonlyArray<string> => {
  const ast = Symbolic.typeOf(schema);
  const members = ast?._tag === "Union" ? ast.types : ast ? [ast] : [];
  return members.flatMap((member) => {
    if (member._tag !== "Objects") return [];
    const tag = member.propertySignatures.find((p) => p.name === "_tag")?.type;
    return tag?._tag === "Literal" && typeof tag.literal === "string" ? [tag.literal] : [];
  });
};

export interface Options {
  /** The most commands in a sequence. */
  readonly depth: number;
  /** The most sequences to run. */
  readonly budget: number;
}

/**
 * Run every sequence of commands on a new instance, up to `depth` commands.
 * A command's fields stay unknown along a whole sequence, so a later command
 * can need something of an earlier one's: the solver picks every value at once.
 */
export const search = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  options: Options,
) {
  const commands = aggregate.definition.commands as unknown as ReadonlyArray<CommandClass>;
  const real = (aggregate.definition.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
  const initial = lift(aggregate.definition.initial);

  const outcomes = new Map<string, { -readonly [K in keyof Outcome]: Outcome[K] }>();
  for (const command of commands) {
    for (const event of command.events)
      outcomes.set(`${command.tag} records ${event.tag}`, {
        command: command.tag,
        kind: "records",
        tag: event.tag,
        story: undefined,
      });
    for (const rejection of command.rejects)
      outcomes.set(`${command.tag} rejects ${rejection.tag}`, {
        command: command.tag,
        kind: "rejects",
        tag: rejection.tag,
        story: undefined,
      });
  }
  const reached = new Map<string, Story | undefined>(
    stateTags(definition.state).map((tag) => [tag, undefined]),
  );
  const broken = new Map<string, Story | undefined>(
    Paths.invariantNames(definition).map((name) => [name, undefined]),
  );
  const unread = new Map<string, Value.NotTranslated>();
  const disagreements = new Set<string>();

  // A new instance is the first state reached.
  for (const [name, holds] of Object.entries(real))
    if (broken.has(name) && holds(aggregate.definition.initial) !== true) broken.set(name, []);

  /**
   * The invariants each command keeps whatever state it meets: after that
   * command they hold in any sequence, and no sequence is asked about them.
   * The proofs take the state a command meets to be one its schema allows, so
   * they count only when a new instance is and every command keeps it so.
   */
  const rows = yield* Induction.rows(solver, interpreter, aggregate, definition);
  const kept = new Map<string, ReadonlySet<string>>(
    Schema.is(definition.state as Schema.Schema<unknown>)(aggregate.definition.initial) &&
      Induction.closed(rows)
      ? rows.map((row) => [
          row.command,
          new Set(
            [...row.verdicts].flatMap(([name, verdict]) =>
              verdict._tag === "Proved" ? [name] : [],
            ),
          ),
        ])
      : [],
  );
  let states = 0;
  const looked = new Map<string, number>();
  const undecided = new Map<string, number>();
  const gaveUp = (reason: string) => undecided.set(reason, (undecided.get(reason) ?? 0) + 1);

  const shorter = (story: Story | undefined, length: number) => !story || story.length > length;

  /** The solver's values as real commands, run one after another on the real code. */
  const replay = Effect.fn(function* (
    trail: ReadonlyArray<Entry>,
    run: Value.Run,
    model: Check.Model,
  ) {
    const build = (what: string, value: V) => {
      const built = Symbolic.concretize(value, model);
      return "value" in built
        ? Effect.succeed(built.value)
        : Effect.fail(new Disagreement({ reason: `${built.reason} (${what})` }));
    };
    const id = (yield* build("id", trail[0]!.inputs.id)) as string;
    let state: unknown = aggregate.definition.initial;
    let version = 0;
    const story: Array<Move> = [];
    for (const [index, entry] of trail.entries()) {
      const { _tag: tag, ...fields } = (yield* build("command", entry.inputs.command)) as {
        readonly _tag: string;
      };
      const cls = entry.command as unknown as new (fields: object) => { readonly _tag: string };
      const command = yield* Effect.try({
        try: () => new cls(fields),
        catch: (cause) =>
          new Disagreement({
            reason: `${tag} refuses the solver's input ${Symbolic.show(fields)}: ${String(cause)}`,
          }),
      });
      let context = Context.empty() as Context.Context<unknown>;
      const read: Array<{ name: string; value: unknown }> = [];
      for (const [key, held] of run.contexts) {
        if (!key.startsWith(entry.label)) continue;
        const value = yield* build(key, held.value);
        context = Context.add(context, held.tag as Context.Key<unknown, unknown>, value);
        read.push({ name: key.slice(key.lastIndexOf("/") + 1), value });
      }
      const now = (yield* build("now", entry.inputs.now)) as DateTime.Utc;
      const prediction = Aggregate.predict(aggregate, state, command, {
        id,
        now,
        version,
        commandId: (yield* build("commandId", entry.inputs.commandId)) as string,
        context: context as Context.Context<never>,
      });
      const where = `command ${index + 1}, ${Symbolic.show(command)}`;
      if (prediction._tag === "Unpredictable")
        return yield* new Disagreement({
          reason: `the real code fails on ${where}: ${Cause.pretty(prediction.cause)}`,
        });
      const expected =
        entry.applied._tag === "Rejected"
          ? `rejects with ${tagOf(entry.applied.rejection)}`
          : `records [${(entry.applied._tag === "Changed" ? entry.applied.events : []).map(tagOf).join(", ")}]`;
      const actual =
        prediction._tag === "Rejected"
          ? `rejects with ${prediction.rejection._tag}`
          : `records [${prediction.events.map((event) => event._tag).join(", ")}]`;
      if (expected !== actual)
        return yield* new Disagreement({
          reason: `the explorer read that ${where} ${expected}, but the real code ${actual}`,
        });
      if (prediction._tag === "Rejected") {
        story.push({
          command,
          context: read,
          now,
          outcome: { _tag: "Rejected", rejection: prediction.rejection },
        });
      } else {
        state = prediction.state;
        version += prediction.events.length;
        story.push({
          command,
          context: read,
          now,
          outcome: { _tag: "Accepted", events: prediction.events, state },
        });
      }
    }
    return { story, state };
  });

  /**
   * Values for the sequence that make `condition` false, where no time passes
   * between commands if the sequence allows it: a time in a story then means
   * the story needs it.
   */
  const values = Effect.fn(function* (
    trail: ReadonlyArray<Entry>,
    run: Value.Run,
    condition: string,
  ) {
    const answer = yield* Check.solve(solver, run, condition);
    if (answer._tag !== "Sat" || trail.length < 2) return answer;
    const still = trail
      .slice(1)
      .map(
        (entry, index) =>
          `(= ${Smt.symbol(`${entry.label}now`)} ${Smt.symbol(`${trail[index]!.label}now`)})`,
      );
    const again = yield* Check.solve(
      solver,
      run,
      `(or ${condition} (not (and ${still.join(" ")})))`,
    );
    return again._tag === "Sat" ? again : answer;
  });

  const attempt = (trail: ReadonlyArray<Entry>, run: Value.Run, model: Check.Model) =>
    replay(trail, run, model).pipe(
      Effect.catchTag("Disagreement", (error) =>
        Effect.sync(() => {
          disagreements.add(error.reason);
          return undefined;
        }),
      ),
    );

  /**
   * Look at the sequence so far, after its last command. Says whether it can
   * happen at all: when it cannot, nothing longer is run.
   */
  const visit = Effect.fn(function* (
    run: Value.Run,
    trail: ReadonlyArray<Entry>,
    checks: ReadonlyArray<Paths.Check>,
  ) {
    const last = trail[trail.length - 1]!;
    const applied = last.applied;
    const changed = applied._tag === "Changed";

    const wantedOutcomes: Array<string> = [];
    let wantedState: string | undefined;
    const want = (kind: Outcome["kind"], tag: string | undefined) => {
      if (tag === undefined) return;
      const name = `${last.command.tag} ${kind} ${tag}`;
      if (!outcomes.has(name))
        outcomes.set(name, { command: last.command.tag, kind, tag, story: undefined });
      if (shorter(outcomes.get(name)!.story, trail.length)) wantedOutcomes.push(name);
    };
    if (applied._tag === "Rejected") want("rejects", tagOf(applied.rejection));
    if (applied._tag === "Changed") {
      for (const event of applied.events) want("records", tagOf(event));
      const tag = tagOf(applied.state);
      if (tag !== undefined && shorter(reached.get(tag), trail.length)) wantedState = tag;
    }

    let feasible = true;
    if (
      (changed && trail.length < options.depth) ||
      wantedOutcomes.length > 0 ||
      wantedState !== undefined
    ) {
      const wanted = wantedOutcomes.length > 0 || wantedState !== undefined;
      const answer = yield* wanted
        ? values(trail, run, "false")
        : Check.solve(solver, run, "false");
      if (answer._tag === "Unsat") feasible = false;
      if (answer._tag === "Unknown") gaveUp(answer.reason);
      if (answer._tag === "Sat" && wanted) {
        const replayed = yield* attempt(trail, run, answer.model);
        if (replayed) {
          for (const name of wantedOutcomes) outcomes.get(name)!.story = replayed.story;
          if (wantedState !== undefined) reached.set(wantedState, replayed.story);
        }
      }
    }

    if (feasible && changed) {
      states++;
      const open: Array<string> = [];
      for (const check of checks) {
        if (Result.isFailure(check.condition)) {
          const error = check.condition.failure;
          unread.set(`${error.file}:${error.line}`, error);
          continue;
        }
        looked.set(check.name, (looked.get(check.name) ?? 0) + 1);
        if (
          check.condition.success !== "true" &&
          !kept.get(last.command.tag)?.has(check.name) &&
          shorter(broken.get(check.name), trail.length)
        ) {
          open.push(check.condition.success);
        }
      }
      if (open.length > 0) {
        const answer = yield* values(
          trail,
          run,
          open.length === 1 ? open[0]! : `(and ${open.join(" ")})`,
        );
        if (answer._tag === "Unknown") gaveUp(answer.reason);
        if (answer._tag === "Sat") {
          const replayed = yield* attempt(trail, run, answer.model);
          if (replayed) {
            const failed = Object.entries(real).filter(
              ([, holds]) => holds(replayed.state) !== true,
            );
            if (failed.length === 0)
              disagreements.add(
                "the solver found a sequence that breaks an invariant, but the real code keeps every invariant on it",
              );
            for (const [name] of failed)
              if (shorter(broken.get(name), trail.length)) broken.set(name, replayed.story);
          }
        }
      }
    }

    return feasible;
  });

  let sequences = 0;
  let truncated = false;

  /** A sequence that can happen and can go on: the run at its end, and the state it leaves. */
  interface Open {
    readonly run: Value.Run;
    readonly trail: ReadonlyArray<Entry>;
    readonly state: V;
    readonly version: number;
  }

  /**
   * Every sequence one command longer than this one. Each next command is
   * read from the end of the sequence, once for each path through it, so no
   * command of a sequence is read twice.
   */
  const extend = Effect.fn(function* (from: Open, longer: Array<Open>) {
    const length = from.trail.length + 1;
    const label = `${length}.`;
    for (const command of commands) {
      let prefix: ReadonlyArray<number> | undefined = [];
      while (prefix) {
        if (sequences >= options.budget) {
          truncated = true;
          return;
        }
        const run = from.run.fork(prefix);
        interpreter.current.run = run;
        // Time does not run backwards between commands.
        const now = run.constant(`${label}now`, "Int");
        if (length > 1) run.assume(`(>= ${now.text} ${Smt.symbol(`${length - 1}.now`)})`);
        const stepped = yield* Paths.step(
          interpreter,
          definition,
          command,
          from.state,
          Value.num(from.version),
          label,
        ).pipe(
          Effect.flatMap((step) =>
            step.applied._tag === "Changed"
              ? Paths.checks(interpreter, definition, step.applied.state).pipe(
                  Effect.map((checks) => ({ step, checks })),
                )
              : Effect.succeed({ step, checks: [] as ReadonlyArray<Paths.Check> }),
          ),
          Effect.result,
        );
        prefix = Value.nextPrefix(run.taken);
        if (Result.isFailure(stepped)) {
          const error = stepped.failure;
          if (error._tag === "NotTranslated") unread.set(`${error.file}:${error.line}`, error);
          sequences++;
          continue;
        }
        const { step, checks } = stepped.success;
        const trail = [
          ...from.trail,
          { command, label, inputs: step.inputs, applied: step.applied },
        ];
        const feasible = yield* visit(run, trail, checks);
        if (feasible && step.applied._tag === "Changed" && length < options.depth)
          longer.push({
            run,
            trail,
            state: step.applied.state,
            version: from.version + step.applied.events.length,
          });
        else sequences++;
      }
    }
  });

  // Shorter sequences first: a story is then the shortest there is, and a
  // search that stops at its budget has run every sequence up to some length.
  let open: Array<Open> = [{ run: new Value.Run([]), trail: [], state: initial, version: 0 }];
  let complete = 0;
  while (open.length > 0 && !truncated) {
    const longer: Array<Open> = [];
    for (const from of open) {
      yield* extend(from, longer);
      if (truncated) break;
    }
    if (!truncated) complete++;
    open = longer;
  }

  const found: Found = {
    sequences,
    states,
    truncated,
    complete,
    invariants: [...broken].map(([name, story]) => ({
      name,
      broken: story,
      proved: !story && commands.every((command) => kept.get(command.tag)?.has(name) === true),
      states: looked.get(name) ?? 0,
    })),
    dead: rows.flatMap((row) => (row.accepted === false ? [row.command] : [])),
    outcomes: [...outcomes.values()],
    reached: [...reached].map(([tag, story]) => ({ tag, story })),
    unread: [...unread.values()],
    disagreements: [...disagreements],
    undecided: [...undecided].map(([reason, times]) => ({ reason, times })),
  };
  return found;
});
