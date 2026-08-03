import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/**
 * The ENCODED form of a round failure — what a `crashed` observation
 * carries across storage and RPC. The kernel never renders errors
 * (spec §11b): projections, boards, and UIs own presentation.
 * JSON-serializable by construction, like every observation.
 */
export interface EncodedCrash {
  /** The error's tag — for AiErrors, the semantic REASON tag
   *  (`InvalidRequestError`, `RateLimitError`, …), not the wrapper. */
  readonly _tag: string | undefined;
  /** One human-readable line — no stack, no `Cause(...)` wrapper. */
  readonly message: string;
  /**
   * The error's own testimony on whether re-running could succeed
   * (`AiError.isRetryable`). Errors carrying no testimony default to
   * retryable — the recovery loop's bounded budget is the safety net.
   */
  readonly retryable: boolean;
}

/**
 * A round exhausted its recovery budget (interrupted `attempts` times
 * with no completed sampling) and was abandoned — the typed failure
 * every waiter on that round receives.
 */
export class RoundAbandoned extends Data.TaggedError("RoundAbandoned")<{
  readonly term: string;
  readonly key: string;
  readonly attempts: number;
}> {
  override get message() {
    return (
      `run '${this.term}/${this.key}': round abandoned after ` +
      `${this.attempts} interrupted attempts`
    );
  }
}

/**
 * The envelope every observation carries: which run it belongs to
 * (`term` + `key`), WHERE in that run's history it sits (`seq` — a
 * per-run monotonic sequence, the resume/dedupe cursor), and when.
 */
export interface ObservationEnvelope {
  readonly term: string;
  readonly key: string;
  /** Per-run monotonic sequence number — the catch-up cursor. */
  readonly seq: number;
  readonly at: number;
}

/**
 * One structured fact about a kernel's execution — enough to
 * reconstruct every run's TRANSCRIPT (inputs, assistant text, tool
 * calls and their results) and to stream it live. Deliberately the
 * KERNEL's vocabulary, not any UI protocol's: every surveyed harness
 * (Codex, OpenCode, Mastra, flue) keeps a canonical internal event log
 * and translates at the edge (see designs/ai/streaming.md).
 * JSON-serializable by construction.
 */
export type KernelObservation = ObservationEnvelope &
  (
    | {
        readonly type: "admitted";
        /** The run whose dispatch/send caused this admission, if any. */
        readonly parent?: { readonly term: string; readonly key: string };
      }
    | {
        /** A message appended to the run's thread: work item, steer, or note. */
        readonly type: "input";
        readonly text: string;
        /**
         * PROVENANCE, structural: `note` = kernel-authored aside
         * (`AI.say`, recovery notes); `reminder` = a `Thread.remind`
         * delivery (the run's own past self). Absent = an ordinary
         * message (world event or steer). The in-band text markers
         * (`<note>`, `[reminder]`) remain — they are MODEL-facing;
         * this field is for projections, which must never parse them.
         */
        readonly kind?: "note" | "reminder";
      }
    | {
        /**
         * One TOKEN SLICE of an in-flight sampling — text or thinking as
         * the provider streams it. Purely a live-view fact: the final
         * `assistant` observation restates the whole sampling and is the
         * canonical record (deltas need not be retained, and a transient
         * provider retry may replay them).
         */
        readonly type: "assistant-delta";
        readonly tick: number;
        readonly channel: "text" | "reasoning";
        readonly delta: string;
      }
    | {
        /**
         * A tool call the IN-FLIGHT sampling just made, surfaced the
         * moment it streams — its handler may run for minutes (a
         * dispatched subagent) before the sampling's final `assistant`
         * observation restates it. Live-view fact, same caveats as
         * `assistant-delta`.
         */
        readonly type: "tool-call";
        readonly tick: number;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly input: unknown;
      }
    | {
        /** One sampling's response — text and/or tool calls. */
        readonly type: "assistant";
        /** The sampling's ordinal within its run (0-based). */
        readonly tick: number;
        /** Model round-trip INCLUDING the tool handlers that ran inside it. */
        readonly ms: number;
        readonly text: string;
        /** The sampling's thinking trace, when the model produced one. */
        readonly reasoning?: string;
        /** Tool calls the model made this sampling; empty = quiesced. */
        readonly toolCalls: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly input: unknown;
        }>;
      }
    | {
        readonly type: "tool-result";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly output: unknown;
        readonly isFailure: boolean;
      }
    | {
        /**
         * A DELEGATION left this run: the intrinsic `dispatch` or a
         * policy door (`AI.Dispatch`) handed a task to another agent.
         * Emitted when the handler runs, so observers can pair the
         * tool call with the worker thread it created (`key` is the
         * child run's key; undefined when the child was minted
         * anonymously).
         */
        readonly type: "dispatched";
        readonly tick: number;
        readonly toolName: string;
        readonly agent: string;
        /** The child run's key; undefined when minted anonymously. */
        readonly child: string | undefined;
      }
    | {
        /**
         * The run QUIESCED with an empty inbox and is parked — its
         * work is done until the world moves (the next input wakes
         * it). The line between "working" and "waiting" for any UI.
         */
        readonly type: "parked";
      }
    | { readonly type: "settled" }
    | {
        /**
         * The current round FAILED. `fatal` distinguishes the two
         * §11b lanes this observation covers: a non-retryable typed
         * failure abandoned on the spot (`fatal: true`) vs a defect
         * the bounded recovery loop will re-enter (`fatal` absent).
         * Rows written before the EncodedCrash shape carry a plain
         * string in `error` — renderers must tolerate both.
         */
        readonly type: "crashed";
        readonly error: EncodedCrash | string;
        readonly fatal?: boolean;
      }
  );

/**
 * The kernel's OBSERVABILITY seam — an optional service (the same
 * pattern as `WireMode`): when present in the context a kernel is
 * interpreted in, every run lifecycle fact is emitted into it;
 * absent, the kernel spends nothing. Emission is fire-and-forget —
 * an observer can never fail or slow a run.
 */
export class KernelObserver extends Context.Service<
  KernelObserver,
  {
    readonly emit: (observation: KernelObservation) => Effect.Effect<void>;
  }
>()("alchemy/AI/KernelObserver") {}
