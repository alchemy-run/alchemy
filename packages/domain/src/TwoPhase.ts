/**
 * How a decision commits across instances that each keep their own storage:
 * a two-phase commit with no coordinator to keep alive.
 *
 * 1. **Read** each instance's state and version, and decide.
 * 2. **Prepare** each instance, in stream order: it checks it still has the
 *    version it was read at, and keeps the decision's events as an *intent*.
 *    While it holds one, it takes no other command.
 * 3. **Commit the first instance** (the *primary*). That one local commit is
 *    the decision's commit point: before it, the decision didn't happen;
 *    after it, it did.
 * 4. **Commit the others**: each turns its intent into events.
 *
 * Whoever runs these steps may die at any point, or lose an answer and not
 * know whether a step happened. So the outcome is never the sender's to
 * state: an instance left holding an intent asks the primary what happened.
 * Committed, so it applies its intent; aborted, so it drops it. Only the primary judges the deadline, on its own
 * clock: a deadline that passes lets it abort an intent nobody committed, and
 * once it has, a late commit finds nothing to commit. Deadlines decide when
 * a stuck instance is freed, never what the outcome was.
 *
 * Preparing in stream order means two decisions that share instances meet at
 * the first one they share, where one waits, so neither holds what the other
 * needs.
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
  /** The instance whose commit decides the outcome: the first, in stream order. */
  readonly primary: Address;
  /** Every other instance of the decision. The primary keeps its outcome until each has it. */
  readonly others: ReadonlyArray<Address>;
  /** The version the instance was read at: it must still have it. */
  readonly version: number;
  /** The events to record on it (encoded); none for one that was only read. */
  readonly events: ReadonlyArray<Json>;
  readonly commandId: string;
  /** Epoch milliseconds the decision was made at: every event's time. */
  readonly now: number;
  readonly correlationId: string;
  readonly trace?: TraceJson;
  /** The decision's receipt, which the primary keeps under the command id. */
  readonly receipt: DecisionReceiptJson;
}

/** What {@link Participant.read} answers. */
export type ReadResult =
  /** Another decision's intent holds the instance. */
  | { readonly _tag: "Busy" }
  /** The command id already committed here (asked of the primary): its receipt. */
  | { readonly _tag: "Decided"; readonly receipt: DecisionReceiptJson }
  | { readonly _tag: "Read"; readonly state: Json; readonly version: number };

/** What {@link Participant.prepare} answers. */
export type PrepareResult =
  | { readonly _tag: "Prepared" }
  /** The instance moved on since it was read. */
  | { readonly _tag: "Conflict" }
  /** Another decision's intent holds the instance. */
  | { readonly _tag: "Busy" }
  /** The command id already committed here (the primary): its receipt. */
  | { readonly _tag: "Decided"; readonly receipt: DecisionReceiptJson };

/**
 * One instance a decision reads, as the commit sees it. Every call is
 * idempotent: a platform retries one that fails in transit.
 */
export interface Participant {
  /**
   * Its state and version, once any intent it holds is settled. Given a
   * command id (the primary is), it answers `Decided` when that command
   * already committed here.
   */
  readonly read: (commandId?: string) => Effect.Effect<ReadResult>;
  /** Check its version and hold the intent. */
  readonly prepare: (prepare: Prepare) => Effect.Effect<PrepareResult>;
  /**
   * Turn the intent into events. `Gone` when it holds no such intent and
   * didn't commit it: on the primary, the decision was aborted. Asked twice,
   * the primary answers `Committed` twice.
   */
  readonly commit: (txId: string) => Effect.Effect<"Committed" | "Gone">;
  /**
   * Give the intent up. The primary drops it. Any other instance asks the
   * primary what happened first, and applies the intent if it committed: a
   * sender whose commit's answer was lost doesn't know that it did.
   */
  readonly abort: (txId: string) => Effect.Effect<void>;
  /** On the primary: these instances have the outcome, so it may forget it. */
  readonly forget: (txId: string, others: ReadonlyArray<Address>) => Effect.Effect<void>;
}

/** What a commit strategy is given for one send. */
export interface CommitInput {
  readonly kit: DecisionKit;
  readonly command: Json;
  readonly meta: Aggregate.SendMeta;
  /** The instance behind a read. */
  readonly participant: (read: DecisionRead) => Participant;
  /** A fresh id for each attempt. */
  readonly txId: Effect.Effect<string>;
}

/** Decide a command and commit what it records, across the instances it reads. */
export type CommitStrategy = (input: CommitInput) => Effect.Effect<DecisionResult>;

/** An attempt lost a race: an instance moved on, or another decision held it. Try again. */
class Contended extends Data.TaggedError("Contended")<{}> {}

/**
 * How long an attempt may hold its instances before the primary lets anyone
 * abort it. An attempt takes a few calls; one that outlives this is aborted
 * and tried again.
 */
export const INTENT_TTL_MS = 5_000;

/**
 * Backs off from 10ms to 250ms, about 20 seconds in all: longer than an
 * intent lives, so a decision waits out one left by a caller that died.
 */
const CONTENDED = {
  schedule: Schedule.min([Schedule.exponential("10 millis"), Schedule.spaced("250 millis")]).pipe(
    Schedule.jittered,
  ),
  times: 90,
} as const;

const settled = <A>(effect: Effect.Effect<A>) => Effect.catchCause(effect, () => Effect.void);

/**
 * The two-phase commit described in this module's header.
 */
export const twoPhase: CommitStrategy = ({ kit, command, meta, participant, txId }) => {
  const attempt = Effect.gen(function* () {
    const reads = yield* kit.reads(command);
    const parts = reads.map(participant);
    const results = yield* Effect.forEach(
      parts,
      // Only the primary keeps the receipt of a command it committed.
      (part, index) => part.read(index === 0 ? meta.commandId : undefined),
      { concurrency: "unbounded" },
    );
    const decided = results[0];
    if (decided?._tag === "Decided") {
      return { _tag: "Accepted", receipt: decided.receipt } satisfies DecisionResult;
    }
    const states = [];
    for (const [index, result] of results.entries()) {
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
      const again = yield* Effect.forEach(parts, (part) => part.read(), {
        concurrency: "unbounded",
      });
      for (const [index, read] of again.entries()) {
        if (read._tag !== "Read" || read.version !== states[index]!.version) {
          return yield* new Contended();
        }
      }
      return result satisfies DecisionResult;
    }
    const accepted: DecisionResult = { _tag: "Accepted", receipt: result.receipt };
    // A command that reads nothing records nothing.
    const primary = parts[0];
    if (primary === undefined) return accepted;
    const id = yield* txId;
    const addresses = result.writes.map(({ aggregate, id }) => ({ aggregate, id }));
    const prepared: Array<Participant> = [];
    // The primary first: it decides the outcome, so an instance whose abort
    // is lost learns it from there.
    const abort = Effect.suspend(() =>
      Effect.forEach(prepared, (part) => settled(part.abort(id)), { discard: true }),
    );
    // From the first intent to the last commit, finish or undo: an interrupted
    // send never leaves instances held longer than it must.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        for (const [index, write] of result.writes.entries()) {
          const part = parts[index]!;
          const answer = yield* part.prepare({
            txId: id,
            primary: addresses[0]!,
            others: addresses.slice(1),
            version: write.version,
            events: write.events,
            commandId: meta.commandId,
            now,
            correlationId: result.correlationId,
            ...(result.trace ? { trace: result.trace } : {}),
            receipt: result.receipt,
          });
          if (answer._tag === "Prepared") {
            prepared.push(part);
            continue;
          }
          yield* abort;
          if (answer._tag === "Decided" && index === 0) {
            return { _tag: "Accepted", receipt: answer.receipt } satisfies DecisionResult;
          }
          return yield* new Contended();
        }
        // The commit point. `Gone`: the deadline passed and someone aborted it.
        if ((yield* primary.commit(id)) === "Gone") {
          yield* abort;
          return yield* new Contended();
        }
        // The decision happened. An instance this doesn't reach asks the primary,
        // which keeps the outcome until that instance has it.
        const reached = yield* Effect.forEach(
          parts.slice(1),
          (part, index) =>
            part.commit(id).pipe(
              Effect.as([addresses[index + 1]!]),
              Effect.catchCause(() => Effect.succeed([])),
            ),
          { concurrency: "unbounded" },
        );
        yield* settled(primary.forget(id, reached.flat()));
        return accepted;
      }).pipe(Effect.onError(() => abort)),
    );
  });
  return attempt.pipe(
    Effect.retry({ ...CONTENDED, while: (error) => error._tag === "Contended" }),
    Effect.catchTag("Contended", () =>
      Effect.die(
        new Error(
          `${kit.name}: the instances it reads stayed held or kept changing; ` +
            "another decision on them may have stopped midway",
        ),
      ),
    ),
  );
};

/**
 * How decisions commit on a platform whose instances each keep their own
 * storage. Two-phase commit by default; provide another strategy to the
 * platform's Layer to replace it.
 */
export const DecisionCommit = Context.Reference<CommitStrategy>("alchemy/Domain/DecisionCommit", {
  defaultValue: () => twoPhase,
});
