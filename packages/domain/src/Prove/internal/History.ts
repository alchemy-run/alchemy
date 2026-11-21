import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import { lift } from "../../Explore/internal/Search.ts";
import * as Check from "./Check.ts";
import * as Interpreter from "./Interpreter.ts";
import * as Paths from "./Paths.ts";
import * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import * as Value from "./Value.ts";

type V = Value.V;

/** One event of an instance's history, with what was recorded of the command that left it. */
export interface Recorded {
  readonly event: { readonly _tag: string };
  /** The command that recorded it: events that share one were recorded together. */
  readonly commandId: string | undefined;
  /** When it was committed. */
  readonly at: DateTime.Utc | undefined;
}

/** What is wrong with a history, each with the place of the event it is at, from 1. */
export type Finding =
  /** A rule does not hold of the state the events up to here leave. */
  | {
      readonly _tag: "Broken";
      readonly seq: number;
      readonly rule: string;
      readonly state: unknown;
    }
  /** No command of the aggregate records these events from the state they met. */
  | {
      readonly _tag: "Unexplained";
      readonly seq: number;
      readonly events: ReadonlyArray<unknown>;
      readonly state: unknown;
    }
  /** `evolve` cannot fold the event. */
  | { readonly _tag: "Unfolded"; readonly seq: number; readonly reason: string };

export interface Report {
  /** How many events were folded. */
  readonly events: number;
  /** The commands found that record them: each with the events it explains. */
  readonly commands: number;
  /** The events one of those commands records. */
  readonly explained: number;
  /** The events none of the aggregate's commands can record: a decision's, or imported. */
  readonly outside: number;
  /** The events the prover could not tell of, each with why. */
  readonly undecided: ReadonlyArray<{ readonly seq: number; readonly reason: string }>;
  readonly findings: ReadonlyArray<Finding>;
  /** The state the whole history leaves. */
  readonly state: unknown;
}

/** The most paths of one command tried against one place in a history. */
const MAX_PATHS = 256;

const all = (parts: ReadonlyArray<string>): string =>
  parts.length === 0 ? "true" : parts.length === 1 ? parts[0]! : `(and ${parts.join(" ")})`;

/**
 * That a value the prover holds is a real one: known, a formula, or
 * `undefined` where the prover cannot say.
 */
const equal = (read: V, real: V): false | string | undefined => {
  if (read._tag === "Time" && real._tag === "Time")
    return `(= ${read.millis.text} ${real.millis.text})`;
  if (read._tag === "Arr" && real._tag === "Arr") {
    if (read.items.length !== real.items.length) return false;
    return every(read.items.map((item, index) => equal(item, real.items[index]!)));
  }
  if (read._tag === "Obj" && real._tag === "Obj") {
    const keys = new Set([...Object.keys(read.fields), ...Object.keys(real.fields)]);
    return every(
      [...keys].map((key) =>
        equal(read.fields[key] ?? Value.undef, real.fields[key] ?? Value.undef),
      ),
    );
  }
  // A list no code looked at has no items to compare yet.
  if (read._tag === "List") return undefined;
  if (read._tag === "Obj" || real._tag === "Obj" || read._tag === "Arr" || real._tag === "Arr")
    return false;
  const same = Interpreter.same(read, real);
  return same === true ? "true" : same;
};

const every = (parts: ReadonlyArray<boolean | string | undefined>): false | string | undefined => {
  if (parts.includes(false)) return false;
  if (parts.includes(undefined)) return undefined;
  return all(parts.filter((part) => typeof part === "string" && part !== "true") as Array<string>);
};

/** A command the real code records a run of events with. */
interface Explained {
  readonly command: { readonly _tag: string };
  readonly context: Context.Context<never>;
  readonly events: ReadonlyArray<{ readonly _tag: string }>;
  readonly state: unknown;
}

/**
 * Fold an instance's events from its initial state, and hold each step
 * against the aggregate as it is written now: every state along the way
 * keeps the invariants and the schema, and each run of events is one a
 * command records from the state it met. The command is found by the
 * solver, on what the prover read of `decide`, and counts only once the
 * real `decide` records the same events with it.
 */
export const check = Effect.fn(function* (
  solver: Smt.Solver,
  interpreter: Interpreter.Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  history: ReadonlyArray<Recorded>,
  id: string | undefined,
) {
  const def = aggregate.definition;
  const evolve = def.evolve as unknown as Record<
    string,
    ((state: unknown, event: unknown, envelope: unknown) => unknown) | undefined
  >;
  const invariants = (def.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
  const rules = Check.rules(aggregate);
  /** The events a command of the aggregate may record. */
  const own = new Set<string>(
    def.commands.flatMap((command) => command.events.map((event) => event.tag)),
  );
  const findings: Array<Finding> = [];
  const undecided: Array<{ readonly seq: number; readonly reason: string }> = [];
  const stream = `${aggregate.aggregateName}/${id ?? ""}`;

  /** The state after one event, as the platform folds it. */
  const fold = (state: unknown, recorded: Recorded, seq: number) =>
    Effect.try({
      try: () => {
        const handler = evolve[recorded.event._tag];
        if (!handler) return { _tag: "Unfolded", reason: "evolve has no handler for it" } as const;
        return {
          _tag: "Folded",
          state: handler(state, recorded.event, {
            id: id ?? "",
            stream,
            seq,
            at: recorded.at ?? DateTime.makeUnsafe(0),
            commandId: recorded.commandId ?? "",
            correlationId: recorded.commandId ?? "",
          }),
        } as const;
      },
      catch: (cause) => ({ _tag: "Unfolded", reason: `evolve threw: ${String(cause)}` }) as const,
    }).pipe(Effect.catch((unfolded) => Effect.succeed(unfolded)));

  /** Each invariant, and the schema, on a state the history reaches. */
  const hold = Effect.fn(function* (state: unknown, seq: number) {
    if (!Schema.is(def.state)(state))
      findings.push({ _tag: "Broken", seq, rule: "the state's schema", state });
    for (const [name, holds] of Object.entries(invariants))
      if (!(yield* Effect.try(() => holds(state)).pipe(Effect.orElseSucceed(() => false))))
        findings.push({ _tag: "Broken", seq, rule: name, state });
  });

  /**
   * A command that records the events at one place in the history, from the
   * state they met: the one that explains the most of them.
   */
  const explain = Effect.fn(function* (
    state: unknown,
    version: number,
    upcoming: ReadonlyArray<Recorded>,
    /** How many events the command recorded, where the history says. */
    exactly: number | undefined,
  ) {
    let best: Explained | undefined;
    let unknown: string | undefined;
    const before = lift(state);
    for (const cls of def.commands) {
      const command = cls as unknown as Paths.CommandClass;
      let paths = 0;
      let prefix: ReadonlyArray<number> | undefined = [];
      while (prefix) {
        if (++paths > MAX_PATHS) {
          unknown ??= `${command.tag} has more than ${MAX_PATHS} paths from that state`;
          break;
        }
        const run = new Value.Run(prefix);
        interpreter.current.run = run;
        const stepped = yield* Paths.step(
          interpreter,
          definition,
          command,
          before,
          Value.num(version),
          "",
          id === undefined ? undefined : { id: Value.str(id) },
        ).pipe(
          Effect.catchTags({
            Infeasible: () => Effect.succeed(undefined),
            Rejected: () => Effect.succeed(undefined),
            NotTranslated: (error) =>
              Effect.sync(() => {
                unknown ??= `the prover does not read ${command.tag}: ${error.reason}`;
                return undefined;
              }),
          }),
        );
        prefix = Value.nextPrefix(run.taken);
        if (!stepped || stepped.applied._tag !== "Changed") continue;
        const read = stepped.applied.events;
        if (read.length > upcoming.length || (exactly !== undefined && read.length !== exactly))
          continue;
        if (best && best.events.length >= read.length) continue;
        const first = upcoming[0]!;
        const pinned = every([
          ...read.map((event, index) => equal(event, lift(upcoming[index]!.event))),
          ...(first.at === undefined ? [] : [equal(stepped.inputs.now, lift(first.at))]),
          ...(first.commandId === undefined
            ? []
            : [equal(stepped.inputs.commandId, Value.str(first.commandId))]),
        ]);
        if (pinned === false) continue;
        if (pinned === undefined || run.bounds.size > 0) {
          unknown ??= `${command.tag} records a value the prover cannot compare`;
          continue;
        }
        // Inputs on this path that record exactly these events.
        const answer = yield* Check.solve(solver, run, Smt.not(pinned));
        if (answer._tag === "Unknown") unknown ??= answer.reason;
        if (answer._tag !== "Sat") continue;
        const build = (value: V): unknown => {
          const built = Symbolic.concretize(value, answer.model, run.lists);
          return "value" in built ? built.value : undefined;
        };
        const built = build(stepped.inputs.command) as { readonly _tag: string } | undefined;
        const made = built
          ? yield* Effect.try(() => {
              const { _tag: _, ...fields } = built;
              return new (cls as unknown as new (fields: object) => { readonly _tag: string })(
                fields,
              );
            }).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        if (!made) {
          unknown ??= `the solver found a ${command.tag}, and it cannot be built`;
          continue;
        }
        let context = Context.empty() as Context.Context<unknown>;
        for (const entry of run.contexts.values())
          context = Context.add(
            context,
            entry.tag as Context.Key<unknown, unknown>,
            build(entry.value),
          );
        // The real `decide`, on the command the solver found.
        const prediction = Aggregate.predict(aggregate, state, made, {
          now: first.at ?? (build(stepped.inputs.now) as DateTime.Utc),
          version,
          commandId: first.commandId ?? (build(stepped.inputs.commandId) as string),
          context: context as Context.Context<never>,
        });
        if (
          prediction._tag !== "Accepted" ||
          prediction.events.length !== read.length ||
          !prediction.events.every(
            (event, index) => Check.canon(event) === Check.canon(upcoming[index]!.event),
          )
        ) {
          unknown ??= `the prover read ${Symbolic.show(made)} as recording them, and the real code does something else`;
          continue;
        }
        best = {
          command: made,
          context: context as Context.Context<never>,
          events: prediction.events,
          state: prediction.state,
        };
      }
    }
    return { best, unknown };
  });

  let state: unknown = def.initial;
  let at = 0;
  let commands = 0;
  let explained = 0;
  let outside = 0;
  while (at < history.length) {
    const first = history[at]!;
    // What one command recorded, where the history says: the events that share its id.
    let together = 1;
    if (first.commandId !== undefined)
      while (history[at + together]?.commandId === first.commandId) together++;
    const exactly = first.commandId === undefined ? undefined : together;
    const upcoming = exactly === undefined ? history.slice(at) : history.slice(at, at + together);
    const found = own.has(first.event._tag)
      ? yield* explain(state, at, upcoming, exactly)
      : undefined;
    if (found?.best) {
      const moved: Check.Moved = {
        before: state,
        after: found.best.state,
        command: found.best.command,
        events: found.best.events,
        context: found.best.context,
      };
      const last = at + found.best.events.length;
      if (!Schema.is(def.state)(moved.after))
        findings.push({
          _tag: "Broken",
          seq: last,
          rule: "the state's schema",
          state: moved.after,
        });
      for (const [name, holds] of Object.entries(rules))
        if (!(yield* Effect.try(() => holds(moved)).pipe(Effect.orElseSucceed(() => false))))
          findings.push({ _tag: "Broken", seq: last, rule: name, state: moved.after });
      commands++;
      explained += found.best.events.length;
      state = moved.after;
      at = last;
      continue;
    }
    // Nothing explains them: they are folded as they are, and the state is still held to the rules.
    const taken = history.slice(at, at + together);
    if (!found) outside += taken.length;
    else if (found.unknown !== undefined) undecided.push({ seq: at + 1, reason: found.unknown });
    else
      findings.push({
        _tag: "Unexplained",
        seq: at + 1,
        events: taken.map((recorded) => recorded.event),
        state,
      });
    let stopped = false;
    for (const [index, recorded] of taken.entries()) {
      const folded = yield* fold(state, recorded, at + index + 1);
      if (folded._tag === "Unfolded") {
        findings.push({ _tag: "Unfolded", seq: at + index + 1, reason: folded.reason });
        stopped = true;
        break;
      }
      state = folded.state;
    }
    // A state `evolve` could not reach says nothing of the events after it.
    if (stopped) {
      at = history.length;
      break;
    }
    at += taken.length;
    yield* hold(state, at);
  }
  const report: Report = {
    events: at,
    commands,
    explained,
    outside,
    undecided,
    findings,
    state,
  };
  return report;
});
