import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

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
    | { readonly type: "admitted" }
    | {
        /** A message appended to the run's thread: work item, steer, or note. */
        readonly type: "input";
        readonly text: string;
      }
    | {
        /** One sampling's response — text and/or tool calls. */
        readonly type: "assistant";
        /** The sampling's ordinal within its run (0-based). */
        readonly tick: number;
        /** Model round-trip INCLUDING the tool handlers that ran inside it. */
        readonly ms: number;
        readonly text: string;
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
    | { readonly type: "settled" }
    | { readonly type: "crashed"; readonly error: string }
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
