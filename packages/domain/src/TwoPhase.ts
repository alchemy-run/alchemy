/**
 * How a decision commits across instances that each keep their own storage:
 * a two-phase commit that one of the instances drives.
 *
 * The first instance the command reads, in stream order, is the *primary*.
 * Whoever sends the command makes one call, to the primary, and the primary
 * does the rest:
 *
 * 1. **Read** its own state and every other instance's, and decide.
 * 2. **Hold** the whole decision in its own storage: its events, and what
 *    each other instance is to record. From here the decision no longer
 *    depends on anyone's memory.
 * 3. **Prepare** each other instance. It checks that it still has the version
 *    it was read at, and keeps its events as an *intent*. While an instance
 *    holds one, it takes no other command.
 * 4. **Commit** itself, in one local transaction. That is the commit point:
 *    before it the decision didn't happen, after it it did.
 * 5. **Deliver** the outcome to the others: each turns its intent into
 *    events.
 *
 * **Nothing is decided by a clock.** The outcome changes in one place only, the primary's storage, and only in
 * one atomic step: `commit` or `abort`. Every other step may be repeated, by
 * anyone, any number of times:
 *
 * - `prepare` for an attempt an instance already holds answers `Prepared`.
 * - `commit` and `abort` on the primary answer what became of the attempt.
 * - Delivering an outcome to an instance that has it does nothing.
 *
 * So recovery is to run the same steps again. The primary keeps a durable
 * wake-up while it holds a decision or an outcome somebody hasn't received.
 * If the call that was driving it died (the object was evicted, the sender
 * hung up), the wake-up runs {@link finish} from what is in storage. Should
 * the first driver still be alive, the two overlap harmlessly.
 *
 * The primary aborts for one reason: an instance couldn't be prepared,
 * because it changed, another decision holds it, or it couldn't be reached.
 * The abort is recorded before any other instance is told, and an instance
 * is told to commit only after the commit is recorded. So an instance that
 * hears either can act on it without asking.
 *
 * An instance that holds an intent and hears nothing asks the primary, on
 * its next command or on a wake-up of its own. The primary answers
 * `Pending` while it holds the decision, the recorded outcome once it has
 * one, and `Aborted` for an attempt it no longer knows: it forgets an outcome
 * only once every instance has it, so whoever still asks holds a stray copy.
 *
 * **It can't deadlock.** The primary is the first instance in stream order, so a primary only ever
 * prepares instances after itself. And nothing waits while it holds: a
 * decision that meets a held instance aborts, lets go of everything, and
 * tries again after a pause.
 *
 * @module
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Aggregate from "./Aggregate.ts";
import type {
  DecisionKit,
  DecisionRead,
  DecisionReceiptJson,
  DecisionResult,
  Json,
} from "./Platform.ts";
import type { TraceJson } from "./Telemetry.ts";

/** An instance's address: its aggregate and id. */
export interface Address {
  readonly aggregate: string;
  readonly id: string;
}

/** What an instance is asked to hold until the decision commits or aborts. */
export interface Prepare {
  /** The attempt this intent belongs to: one per try of a decision. */
  readonly txId: string;
  /** The instance that drives the decision and holds its outcome: the first, in stream order. */
  readonly primary: Address;
  /** The version the instance was read at: it must still have it. */
  readonly version: number;
  /** The events to record on it (encoded); none for one that was only read. */
  readonly events: ReadonlyArray<Json>;
  readonly commandId: string;
  /** Epoch milliseconds the decision was made at: every event's time. */
  readonly now: number;
  readonly correlationId: string;
  readonly trace?: TraceJson;
}

/** What another instance is to record: its address, and its part of the decision. */
export interface Part extends Address {
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
}

/**
 * The whole decision, as the primary holds it: its own part, every other
 * instance's, and the receipt. Enough to finish the commit from storage
 * alone.
 */
export interface Plan extends Prepare {
  /** Every other instance, in stream order. */
  readonly others: ReadonlyArray<Part>;
  /** The decision's receipt, kept under the command id once it commits. */
  readonly receipt: DecisionReceiptJson;
}

/** What became of an attempt. */
export type Outcome = "Committed" | "Aborted";

/** Another instance couldn't be reached. Before the commit point, that aborts the attempt. */
export class Unreachable extends Data.TaggedError("Unreachable")<{ readonly cause: unknown }> {}

/** What {@link Participant.read} answers. */
export type ReadResult =
  /** Another decision's intent holds the instance. */
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Read"; readonly state: Json; readonly version: number };

/** What {@link Participant.prepare} answers. */
export type PrepareResult =
  | { readonly _tag: "Prepared" }
  /** The instance moved on since it was read. */
  | { readonly _tag: "Conflict" }
  /** Another decision's intent holds the instance. */
  | { readonly _tag: "Busy" };

/**
 * Another instance of the decision, as the primary calls it. Every call may
 * be repeated.
 */
export interface Participant {
  /** Its state and version, once any intent it holds is settled. */
  readonly read: Effect.Effect<ReadResult, Unreachable>;
  /** Check its version and hold the intent. */
  readonly prepare: (prepare: Prepare) => Effect.Effect<PrepareResult, Unreachable>;
  /** The attempt committed: turn the intent into events. Nothing, if it holds no such intent. */
  readonly commit: (txId: string) => Effect.Effect<void, Unreachable>;
  /** The attempt aborted: drop the intent. Nothing, if it holds no such intent. */
  readonly abort: (txId: string) => Effect.Effect<void, Unreachable>;
}

/**
 * The primary's own storage. Each call is one atomic step, and the only
 * place a decision's outcome changes.
 */
export interface Primary {
  /**
   * Its state and version, once any intent it holds is settled; `Decided`
   * when the command id already committed here.
   */
  readonly read: (
    commandId: string,
  ) => Effect.Effect<
    ReadResult | { readonly _tag: "Decided"; readonly receipt: DecisionReceiptJson }
  >;
  /**
   * Check its own version and hold the plan, with a durable wake-up that
   * finishes it should this call die.
   */
  readonly hold: (
    plan: Plan,
  ) => Effect.Effect<
    | { readonly _tag: "Held" }
    | { readonly _tag: "Conflict" }
    | { readonly _tag: "Busy" }
    | { readonly _tag: "Decided"; readonly receipt: DecisionReceiptJson }
  >;
  /**
   * The commit point: turn its part into events, keep the receipt, and
   * record `Committed` for the others. `Gone` when it neither holds the
   * attempt nor has it recorded as committed.
   */
  readonly commit: (txId: string) => Effect.Effect<"Committed" | "Gone">;
  /**
   * Give the attempt up, and record `Aborted` for the others. Answers
   * `Committed` when it committed first: then it is delivered, not undone.
   */
  readonly abort: (txId: string) => Effect.Effect<Outcome>;
  /** These instances have the outcome. Once every one has, it is forgotten. */
  readonly delivered: (txId: string, others: ReadonlyArray<Address>) => Effect.Effect<void>;
}

/** What drives a decision: the primary's storage, and the way to each other instance. */
export interface Drive {
  readonly primary: Primary;
  readonly participant: (address: Address) => Participant;
}

/**
 * Tell `others` what became of an attempt, and note who received it. An
 * instance this doesn't reach is told again by the primary's wake-up.
 */
export const deliver = (
  drive: Drive,
  txId: string,
  outcome: Outcome,
  others: ReadonlyArray<Address>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (others.length === 0) return;
    const reached = yield* Effect.forEach(
      others,
      ({ aggregate, id }) => {
        const participant = drive.participant({ aggregate, id });
        return (outcome === "Committed" ? participant.commit(txId) : participant.abort(txId)).pipe(
          Effect.as([{ aggregate, id }]),
          Effect.catchTag("Unreachable", () => Effect.succeed([])),
        );
      },
      { concurrency: "unbounded" },
    );
    yield* drive.primary.delivered(txId, reached.flat());
  });

/**
 * Carry a plan the primary holds to its end: prepare the others, commit, and
 * deliver. Every step may be repeated, so this runs again, unchanged, when
 * the call that started it died, and two runs of it may overlap.
 */
export const finish = (drive: Drive, plan: Plan): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    const { others: _, receipt: __, ...shared } = plan;
    for (const other of plan.others) {
      const answer = yield* drive
        .participant(other)
        .prepare({ ...shared, version: other.version, events: other.events })
        .pipe(Effect.catchTag("Unreachable", () => Effect.succeed({ _tag: "Unreachable" })));
      if (answer._tag !== "Prepared") return yield* undo(drive, plan);
    }
    // The commit point. `Gone`: another run of this ended the attempt first.
    if ((yield* drive.primary.commit(plan.txId)) === "Gone") return yield* undo(drive, plan);
    yield* deliver(drive, plan.txId, "Committed", plan.others);
    return "Committed" as const;
  });

/** Abort an attempt, unless it committed first; either way, tell the others. */
const undo = (drive: Drive, plan: Plan) =>
  Effect.gen(function* () {
    const outcome = yield* drive.primary.abort(plan.txId);
    yield* deliver(drive, plan.txId, outcome, plan.others);
    return outcome;
  });

/** An attempt lost a race: an instance moved on, was held, or couldn't be reached. Try again. */
class Contended extends Data.TaggedError("Contended")<{}> {}

/** Backs off from 10ms to 250ms, about 20 seconds in all. */
const CONTENDED = {
  schedule: Schedule.min([Schedule.exponential("10 millis"), Schedule.spaced("250 millis")]).pipe(
    Schedule.jittered,
  ),
  times: 90,
} as const;

/** What the primary is given to decide one command. */
export interface DecideInput {
  readonly kit: DecisionKit;
  readonly command: Json;
  readonly meta: Aggregate.SendMeta;
  readonly drive: Drive;
  /** A fresh id for each attempt. */
  readonly txId: Effect.Effect<string>;
}

/**
 * Decide a command and commit what it records, as the primary: the steps in
 * this module's header. An attempt that loses a race lets go of everything
 * and starts over, against the new states.
 */
export const decide = ({
  kit,
  command,
  meta,
  drive,
  txId,
}: DecideInput): Effect.Effect<DecisionResult> => {
  const attempt = Effect.gen(function* () {
    const reads = yield* kit.reads(command);
    const [own, ...rest] = reads;
    if (own === undefined) return yield* Effect.die(new Error(`${kit.name}: nothing to decide on`));
    const readAll = Effect.all(
      [
        drive.primary.read(meta.commandId),
        Effect.forEach(rest, (read) => drive.participant(read).read, {
          concurrency: "unbounded",
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.catchTag("Unreachable", () => new Contended()));
    const [first, others] = yield* readAll;
    if (first._tag === "Decided") {
      return { _tag: "Accepted", receipt: first.receipt } satisfies DecisionResult;
    }
    const states = [];
    for (const [index, result] of [first, ...others].entries()) {
      if (result._tag !== "Read") return yield* new Contended();
      states.push({ ...reads[index]!, state: result.state, version: result.version });
    }
    const now = yield* Clock.currentTimeMillis;
    const result = yield* kit.decide({
      command,
      commandId: meta.commandId,
      context: meta.context,
      now,
      correlationId: meta.correlationId,
      trace: meta.trace,
      link: meta.link,
      states,
    });
    if (result._tag === "Rejected") {
      // Nothing to commit, but the rejection must come from states that
      // existed together: if no version moved while they were read, they did.
      const [again, othersAgain] = yield* readAll;
      for (const [index, read] of [again, ...othersAgain].entries()) {
        if (read._tag !== "Read" || read.version !== states[index]!.version) {
          return yield* new Contended();
        }
      }
      return result satisfies DecisionResult;
    }
    const [mine, ...theirs] = result.writes;
    const plan: Plan = {
      txId: yield* txId,
      primary: { aggregate: own.aggregate, id: own.id },
      version: mine!.version,
      events: mine!.events,
      commandId: meta.commandId,
      now,
      correlationId: result.correlationId,
      ...(result.trace ? { trace: result.trace } : {}),
      receipt: result.receipt,
      others: theirs.map(({ aggregate, id, version, events }) => ({
        aggregate,
        id,
        version,
        events,
      })),
    };
    const held = yield* drive.primary.hold(plan);
    if (held._tag === "Decided") {
      return { _tag: "Accepted", receipt: held.receipt } satisfies DecisionResult;
    }
    if (held._tag !== "Held") return yield* new Contended();
    if ((yield* finish(drive, plan)) === "Aborted") return yield* new Contended();
    return { _tag: "Accepted", receipt: result.receipt } satisfies DecisionResult;
  });
  return attempt.pipe(
    Effect.retry({ ...CONTENDED, while: (error) => error._tag === "Contended" }),
    Effect.catchTag("Contended", () =>
      Effect.die(
        new Error(
          `${kit.name}: the instances it reads stayed held, kept changing, or couldn't be reached`,
        ),
      ),
    ),
  );
};

/** What a commit strategy is given for one send. */
export interface CommitInput {
  readonly kit: DecisionKit;
  readonly command: Json;
  readonly meta: Aggregate.SendMeta;
  /** Ask an instance to decide the command as its primary: see {@link decide}. */
  readonly primary: (read: DecisionRead) => Effect.Effect<DecisionResult>;
}

/** Decide a command and commit what it records, across the instances it reads. */
export type CommitStrategy = (input: CommitInput) => Effect.Effect<DecisionResult>;

/**
 * The two-phase commit described in this module's header: hand the command
 * to the first instance it reads, which drives the rest.
 */
export const twoPhase: CommitStrategy = ({ kit, command, meta, primary }) =>
  Effect.gen(function* () {
    const [first] = yield* kit.reads(command);
    if (first !== undefined) return yield* primary(first);
    // A command that reads nothing records nothing.
    const result = yield* kit.decide({
      command,
      commandId: meta.commandId,
      context: meta.context,
      now: yield* Clock.currentTimeMillis,
      correlationId: meta.correlationId,
      trace: meta.trace,
      link: meta.link,
      states: [],
    });
    return result._tag === "Rejected" ? result : { _tag: "Accepted", receipt: result.receipt };
  });

/**
 * How decisions commit on a platform whose instances each keep their own
 * storage. Two-phase commit by default; provide another strategy to the
 * platform's Layer to replace it.
 */
export const DecisionCommit = Context.Reference<CommitStrategy>("alchemy/Domain/DecisionCommit", {
  defaultValue: () => twoPhase,
});
