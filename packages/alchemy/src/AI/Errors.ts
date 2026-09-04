import * as Data from "effect/Data";

/**
 * The typed abnormal exit of an agent session: raised by the driver
 * when a session exceeds one of its budget ceilings — a hard limit (tokens,
 * wall-clock, iterations, dollars) or the no-progress detector
 * (`stall`). Ceilings come from the provided `AI.budget({...})` Layer,
 * or from the driver's own default guards when none is given — so
 * `BudgetExceeded` rides EVERY agent's error channel; parents catch
 * it as escalation policy.
 *
 * A budget ceiling is a checkpoint, not a tombstone (§9.3): the ring
 * retains the fold and work item, so re-dispatch after a budget raise
 * continues rather than restarts. `resumeHint` tells the human what to
 * change.
 */
export class BudgetExceeded extends Data.TaggedError("AI.BudgetExceeded")<{
  /** The loop whose budget was exhausted. */
  readonly loop: string;
  /** Which ceiling was hit. */
  readonly limit: "tokens" | "wallClock" | "iterations" | "usd" | "stall";
  /** The configured limit that was exceeded. */
  readonly budget: string | number;
  /** How much was consumed (unknown usage is a declared policy, not a lie). */
  readonly used?: string | number;
  /** Human-actionable resume path, e.g. "raise iterations to resume". */
  readonly resumeHint?: string;
}> {}

/**
 * The typed give-up of a bounded agent session: the session concluded that its
 * halt condition (`Out`) is unachievable — distinct from `BudgetExceeded`
 * (nothing ran out) and from the halt (nothing was achieved).
 *
 * The evidence bar is Codex's shipped `Blocked` semantics (§9.3): a
 * repeat-observed blocker across consecutive iterations, claimed by the
 * session and ratified by the driver/check — never the model's bare refusal.
 * Only `until`-halted loops can refuse (a perpetual ring has nothing to
 * give up on), so `Refused` joins the `Err` channel exactly when the
 * charter declares a bounded exit.
 */
export class Refused extends Data.TaggedError("AI.Refused")<{
  /** The loop whose session gave up. */
  readonly loop: string;
  /** The blocker, with the evidence that ratified it. */
  readonly reason: string;
  /** Consecutive iterations the blocker was observed. */
  readonly observed?: number;
}> {}

/**
 * Raised by a Driver implementation when a term cannot be interpreted —
 * an invalid charter (see `AI.lint`), a missing seam, or a harness
 * failure surfaced at interpretation time.
 */
export class DriverError extends Data.TaggedError("AI.DriverError")<{
  readonly term: string;
  readonly message: string;
}> {}
