import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * The ceilings that bound a {@link Process}'s runs: hard limits (tokens,
 * wall-clock, iterations, dollars) and a no-progress detector (`stall`).
 * All are kernel-enforced pre-call — hitting one raises `BudgetExceeded`
 * in the loop's error channel, a failure for the parent ring to
 * investigate, not a budget to spend.
 */
export interface BudgetLimits {
  tokens?: string;
  wallClock?: string;
  iterations?: number;
  usd?: string;
  /**
   * Maximum consecutive iterations without fold-visible progress before
   * the run is stopped. Stagnation (repetition, oscillation, diminishing
   * delta) is detected by the kernel; the ceiling here is what makes the
   * detection a typed exit rather than a log line.
   */
  stall?: number;
}

/**
 * The per-term budget policy the kernel resolves at interpretation — a
 * `Context.Reference` (same seam as `KernelPolicy`): never in `Req`,
 * always resolvable, defaulting to "no explicit ceilings" (the kernel's
 * own default guards still apply, so exhaustion stays a typed
 * possibility on every Process — `BudgetExceeded` is unconditional in
 * `ProcessErr`).
 */
export const BudgetPolicy = Context.Reference<BudgetLimits>(
  "alchemy/AI/BudgetPolicy",
  { defaultValue: () => ({}) },
);

/**
 * Budget is NOT prose — it is provided where the term is provided
 * (owner ruling): a Layer alongside the term's implementation, never a
 * charter expression (the kernel words the model-visible allowance from
 * the resolved policy).
 *
 * ```ts
 * AI.layer(ResolveGitHubIssue).pipe(
 *   Layer.provide(AI.budget({ tokens: "10M", wallClock: "72h", iterations: 24, stall: 4 })),
 * )
 * ```
 *
 * Future (out of scope today): a per-dispatch override so one call can
 * tighten or extend the Layer-provided ceilings.
 */
export const budget = (limits: BudgetLimits) =>
  Layer.succeed(BudgetPolicy, limits);

/**
 * A control ref that caps how many work items a {@link Process} may have in
 * flight at once. Fan-out gets no term of its own — a pipeline without
 * feedback is not a loop.
 *
 * ```ts
 * AI.concurrency(3)
 * ```
 */
export interface Concurrency {
  "~alchemy/Kind": "Concurrency";
  n: number;
}

export const concurrency = (n: number): Concurrency => ({
  "~alchemy/Kind": "Concurrency",
  n,
});

export const isConcurrency = (value: unknown): value is Concurrency =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Concurrency";
