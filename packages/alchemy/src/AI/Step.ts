import * as Prompt from "effect/unstable/ai/Prompt";
import { commandId } from "./Ids.ts";
import { repairToolPairing, SYNTHETIC_ABORTED } from "./Pairing.ts";

/**
 * The pure step machine (design §2.4): every Kernel implementation
 * structures an agent turn as a pure transition plus a command
 * interpreter. `step(state, feedback) → [state', commands]` — no clocks,
 * no randomness, no I/O, no id generation (ids derive from position), and
 * `StepState` is serializable by construction (it survives
 * `structuredClone` + process restart; nothing in it closes over a
 * function).
 *
 * This module encodes the **kernel-default agent policy** — the execution
 * ring's control parameters, which are deliberately not terms (§8.2):
 *
 * - trigger = the dispatch inbox (a `Dispatched` feedback starts a run)
 * - halt    = "model returned no tool calls"
 * - fold    = append to the carried transcript
 *
 * Purchased rules encoded here (§9.3):
 *
 * - **Truncated-batch rule**: a `length`-truncated response's tool calls
 *   fail wholesale — salvage-parsed params may validate while incomplete.
 *   The synthesized failures are model-visible; the model sees the
 *   truncation and never invents success.
 * - **Steering at the boundary**: steer messages are queued and promoted
 *   only when the next model call is constructed — never mid-turn — and
 *   promotion is what a fresh mandate looks like to the model.
 * - **Pairing repair-on-read**: every constructed prompt passes through
 *   `repairToolPairing`, composing with any upstream fold or trim.
 * - **Tool results append in call order** (order-stability for the
 *   transcript), regardless of settlement order.
 * - **Ceilings fire between any two commands**: the model-call ceiling is
 *   checked before each `CallModel`, not at iteration boundaries only.
 */

// ─── state ───────────────────────────────────────────────────────

export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly params: unknown;
}

export interface SettledToolCall extends PendingToolCall {
  readonly isFailure: boolean;
  readonly result: unknown;
}

export interface StepState {
  readonly session: string;
  /** Increments once per `step()` invocation; commands derive ids from it. */
  readonly stepIndex: number;
  /** The carried transcript (Trace-derived; the kernel-default fold). */
  readonly messages: ReadonlyArray<Prompt.Message>;
  /** Tool calls dispatched and not yet settled, in call order. */
  readonly pending: ReadonlyArray<PendingToolCall>;
  /** Settlements received so far for the current batch, keyed by callId. */
  readonly settled: ReadonlyArray<SettledToolCall>;
  /** Steer messages held for promotion at the next boundary. */
  readonly steerQueue: ReadonlyArray<Prompt.Message>;
  /** Model calls made so far (the minimal ceiling this machine enforces). */
  readonly modelCalls: number;
  /**
   * Tokens consumed so far (input + output totals), accumulated
   * transactionally in the same transition that records each
   * `ModelResponse` — the per-command budget decrement (§2.4/§9.3).
   */
  readonly tokensUsed: number;
  /**
   * Model responses whose usage the provider did not report. Unknown
   * usage is a *declared* count, not a silent zero — policy (fail the
   * run, estimate, ignore) belongs to the ring, but the machine never
   * lies about what it knows (§6 "budget enforcement under unknown
   * usage").
   */
  readonly unknownUsage: number;
  /** The machine's phase — a closed set, serializable. */
  readonly phase: "idle" | "awaiting-model" | "awaiting-tools" | "halted";
  /** Ceilings — checked between any two commands, not per iteration. */
  readonly limits: {
    readonly maxModelCalls: number;
    /** Token ceiling; unlimited when absent (kernel-default policy). */
    readonly maxTokens?: number;
  };
}

export const initialState = (options: {
  readonly session: string;
  readonly maxModelCalls?: number;
  readonly maxTokens?: number;
}): StepState => ({
  session: options.session,
  stepIndex: 0,
  messages: [],
  pending: [],
  settled: [],
  steerQueue: [],
  modelCalls: 0,
  tokensUsed: 0,
  unknownUsage: 0,
  phase: "idle",
  limits: {
    maxModelCalls: options.maxModelCalls ?? 24,
    ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
  },
});

// ─── commands (what the interpreter executes) ────────────────────

export type Command =
  | {
      readonly _tag: "CallModel";
      readonly id: string;
      /** Repaired, steer-promoted prompt for this round. */
      readonly messages: ReadonlyArray<Prompt.Message>;
    }
  | {
      readonly _tag: "CallTool";
      readonly id: string;
      readonly callId: string;
      readonly name: string;
      readonly params: unknown;
    }
  | {
      readonly _tag: "Halt";
      readonly id: string;
      readonly outcome: HaltOutcome;
    };

export type HaltOutcome =
  | { readonly _tag: "Completed"; readonly text: string }
  | {
      readonly _tag: "BudgetExceeded";
      readonly limit: "modelCalls" | "tokens";
      readonly used: number;
      readonly budget: number;
      /** Responses with unreported usage — the ceiling may undercount. */
      readonly unknownUsage: number;
    };

// ─── feedback (what the interpreter reports back) ────────────────

/**
 * The driver folds effect/ai `Response.StreamPart`s into this distilled
 * outcome — the machine stays decoupled from provider part types.
 */
export interface ModelOutcome {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<PendingToolCall>;
  /** effect/ai FinishReason literal ("stop" | "length" | "tool-calls" | …). */
  readonly finishReason: string;
  /**
   * Token totals from the response's finish part; `undefined` when the
   * provider reported none (counted in {@link StepState.unknownUsage}).
   */
  readonly tokens?: number;
}

export type Feedback =
  | {
      readonly _tag: "Dispatched";
      readonly input: ReadonlyArray<Prompt.Message>;
    }
  | {
      readonly _tag: "ModelResponse";
      readonly commandId: string;
      readonly outcome: ModelOutcome;
    }
  | {
      readonly _tag: "ToolSettled";
      readonly callId: string;
      readonly isFailure: boolean;
      readonly result: unknown;
    }
  | {
      readonly _tag: "Steered";
      readonly messages: ReadonlyArray<Prompt.Message>;
    };

// ─── the transition ──────────────────────────────────────────────

export const step = (
  state: StepState,
  feedback: Feedback,
): readonly [StepState, ReadonlyArray<Command>] => {
  let next: StepState = { ...state, stepIndex: state.stepIndex + 1 };

  switch (feedback._tag) {
    case "Dispatched": {
      return callModel({ ...next, messages: [...feedback.input] });
    }

    case "Steered": {
      // held durably; promoted when the next model call is constructed
      return [
        { ...next, steerQueue: [...next.steerQueue, ...feedback.messages] },
        [],
      ];
    }

    case "ModelResponse": {
      const { outcome } = feedback;
      const calls = outcome.toolCalls;

      // transactional budget decrement: usage lands in the SAME transition
      // that records the response — never a separate bookkeeping step
      if (outcome.tokens === undefined) {
        next = { ...next, unknownUsage: next.unknownUsage + 1 };
      } else {
        next = { ...next, tokensUsed: next.tokensUsed + outcome.tokens };
      }

      // assistant message enters the transcript exactly as produced
      const assistant = Prompt.makeMessage("assistant", {
        content: [
          ...(outcome.text.length > 0
            ? [Prompt.makePart("text", { text: outcome.text })]
            : []),
          ...calls.map((call) =>
            Prompt.makePart("tool-call", {
              id: call.callId,
              name: call.name,
              params: call.params,
              providerExecuted: false,
            }),
          ),
        ],
      }) as Prompt.Message;
      const messages = [...next.messages, assistant];

      // truncated-batch rule: never execute salvage-parsed calls
      if (outcome.finishReason === "length" && calls.length > 0) {
        const failures = Prompt.makeMessage("tool", {
          content: calls.map((call) =>
            Prompt.makePart("tool-result", {
              id: call.callId,
              name: call.name,
              isFailure: true,
              result: SYNTHETIC_ABORTED,
            }),
          ),
        }) as Prompt.Message;
        return callModel({ ...next, messages: [...messages, failures] });
      }

      // kernel-default halt: no tool calls ⇒ the turn is complete
      if (calls.length === 0) {
        return [
          { ...next, messages, phase: "halted" },
          [
            {
              _tag: "Halt",
              id: commandId(next.session, next.stepIndex, 0),
              outcome: { _tag: "Completed", text: outcome.text },
            },
          ],
        ];
      }

      // dispatch the batch; settlement order is the interpreter's concern,
      // transcript order is ours
      return [
        {
          ...next,
          messages,
          pending: calls,
          settled: [],
          phase: "awaiting-tools",
        },
        calls.map((call, ordinal) => ({
          _tag: "CallTool" as const,
          id: commandId(next.session, next.stepIndex, ordinal),
          callId: call.callId,
          name: call.name,
          params: call.params,
        })),
      ];
    }

    case "ToolSettled": {
      const pending = next.pending.find(
        (call) => call.callId === feedback.callId,
      );
      if (pending === undefined) return [next, []]; // late/duplicate: ledger noise
      const settled = [
        ...next.settled,
        { ...pending, isFailure: feedback.isFailure, result: feedback.result },
      ];
      if (settled.length < next.pending.length) {
        return [{ ...next, settled }, []];
      }
      // batch complete: append results in CALL order, then next round
      const byId = new Map(settled.map((s) => [s.callId, s]));
      const results = Prompt.makeMessage("tool", {
        content: next.pending.map((call) => {
          const s = byId.get(call.callId)!;
          return Prompt.makePart("tool-result", {
            id: s.callId,
            name: s.name,
            isFailure: s.isFailure,
            result: s.result,
          });
        }),
      }) as Prompt.Message;
      return callModel({
        ...next,
        messages: [...next.messages, results],
        pending: [],
        settled: [],
      });
    }
  }
};

/** Construct the next model round: ceiling check, steer promotion, repair. */
const callModel = (
  state: StepState,
): readonly [StepState, ReadonlyArray<Command>] => {
  const exceeded =
    state.modelCalls >= state.limits.maxModelCalls
      ? {
          limit: "modelCalls" as const,
          used: state.modelCalls,
          budget: state.limits.maxModelCalls,
        }
      : state.limits.maxTokens !== undefined &&
          state.tokensUsed >= state.limits.maxTokens
        ? {
            limit: "tokens" as const,
            used: state.tokensUsed,
            budget: state.limits.maxTokens,
          }
        : undefined;
  if (exceeded !== undefined) {
    return [
      { ...state, phase: "halted" },
      [
        {
          _tag: "Halt",
          id: commandId(state.session, state.stepIndex, 0),
          outcome: {
            _tag: "BudgetExceeded",
            ...exceeded,
            unknownUsage: state.unknownUsage,
          },
        },
      ],
    ];
  }
  // boundary: promote held steers (a renewed mandate), then repair
  const messages = repairToolPairing([...state.messages, ...state.steerQueue]);
  return [
    {
      ...state,
      messages,
      steerQueue: [],
      modelCalls: state.modelCalls + 1,
      phase: "awaiting-model",
    },
    [
      {
        _tag: "CallModel",
        id: commandId(state.session, state.stepIndex, 0),
        messages,
      },
    ],
  ];
};
