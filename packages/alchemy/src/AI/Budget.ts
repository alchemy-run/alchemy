/**
 * A control ref that bounds a {@link Loop} (or an {@link Agent} turn).
 *
 * "Goal met" is the exit that might never fire, so a bounded loop needs
 * ceilings alongside its halt: hard limits (tokens, wall-clock,
 * iterations, dollars) and a no-progress detector (`stall`). All are
 * kernel-enforced pre-call — hitting one raises `BudgetExceeded` in the
 * loop's error channel, a failure for the parent ring to investigate, not
 * a budget to spend.
 *
 * ```ts
 * AI.budget({ tokens: "5M", wallClock: "2h", iterations: 12, stall: 3 })
 * ```
 */
export interface Budget {
  "~alchemy/Kind": "Budget";
  limits: {
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
  };
}

export const budget = (limits: Budget["limits"]): Budget => ({
  "~alchemy/Kind": "Budget",
  limits,
});

export const isBudget = (value: unknown): value is Budget =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Budget";

/**
 * A control ref that caps how many work items a {@link Loop} may have in
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
