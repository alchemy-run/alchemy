/**
 * `Governor` — the CONTROL-PLANE hook that owns the round's BOUNDARY
 * VERDICTS (kernel-assembly.md §4): whether a wake proceeds to a
 * sampling at all, and whether quiescence parks the run or continues
 * it with injected work. This is where pi's four host hooks
 * (`shouldStopBeforeTurn`/`AfterTurn`, `getContinuationMessages`) and
 * every shipped harness's budget/goal machinery live in our design —
 * OUTSIDE the driver, as a Layer.
 *
 * OPTIONAL: absent, {@link defaultGovernor} preserves the kernel's
 * classic behavior — every wake proceeds, quiescence parks. User
 * kernels layer their own:
 *
 * ```ts
 * // an autonomous-mode governor: keep working until the gate passes
 * const Relentless = Layer.succeed(AI.Governor, {
 *   beforeRound: () => Effect.succeed(AI.Proceed),
 *   onQuiesce: (facts) =>
 *     facts.tick > 40
 *       ? Effect.succeed(AI.Park)
 *       : Effect.succeed(AI.Continue(["no human is available — keep going; run the gate before you stop"])),
 * });
 * ```
 *
 * The governor conditions on KERNEL FACTS only, never content — what
 * the model reads is the stance's business (spec §2d); what the loop
 * DOES at its edges is the governor's.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Facts about the round a wake is about to start. */
export interface RoundFacts {
  readonly term: string;
  readonly key: string;
  /** Samplings performed so far on this run. */
  readonly tick: number;
  /** The drained inputs that woke (or joined) this round. */
  readonly inputs: ReadonlyArray<unknown>;
}

/** Facts at quiescence (the model produced no tool calls). */
export interface QuiesceFacts {
  readonly term: string;
  readonly key: string;
  readonly tick: number;
}

export type RoundVerdict =
  | { readonly _tag: "Proceed" }
  | {
      /**
       * Refuse the round: the inputs still enter the thread (they
       * happened), the reason enters as a kernel note, the round's
       * waiters resolve with the reason, and NO sampling runs. The
       * run parks again. Rate limits and budget ceilings live here.
       */
      readonly _tag: "Refuse";
      readonly reason: string;
    };

export type QuiesceVerdict =
  | { readonly _tag: "Park" }
  | {
      /**
       * Keep the round going: the inputs join the thread exactly like
       * delivered messages (no waiters) and the run samples again.
       * Goals and autonomous modes are Continue policies.
       */
      readonly _tag: "Continue";
      readonly inputs: ReadonlyArray<unknown>;
    };

export const Proceed: RoundVerdict = { _tag: "Proceed" };
export const Refuse = (reason: string): RoundVerdict => ({
  _tag: "Refuse",
  reason,
});
export const Park: QuiesceVerdict = { _tag: "Park" };
export const Continue = (inputs: ReadonlyArray<unknown>): QuiesceVerdict => ({
  _tag: "Continue",
  inputs,
});

export interface GovernorService {
  readonly beforeRound: (facts: RoundFacts) => Effect.Effect<RoundVerdict>;
  readonly onQuiesce: (facts: QuiesceFacts) => Effect.Effect<QuiesceVerdict>;
}

export class Governor extends Context.Service<Governor, GovernorService>()(
  "alchemy/AI/Governor",
) {}

/** The shipped default: every wake proceeds; quiescence parks. */
export const defaultGovernor: GovernorService = {
  beforeRound: () => Effect.succeed(Proceed),
  onQuiesce: () => Effect.succeed(Park),
};

export const GovernorDefault = Layer.succeed(Governor, defaultGovernor);
