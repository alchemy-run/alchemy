import { isBudget, isConcurrency } from "./Budget.ts";
import { isCheck } from "./Check.ts";
import { isFold } from "./Fold.ts";
import { isHalt } from "./Halt.ts";
import type { Process } from "./Process.ts";

/**
 * A defect in a charter's control-ref wiring. `error`-severity issues
 * make the charter uninterpretable (the Kernel refuses the term with a
 * `KernelError`); `warning`-severity issues are legal but suspicious.
 */
export interface LintIssue {
  readonly severity: "error" | "warning";
  readonly code:
    | "multiple-halts"
    | "conflicting-halts"
    | "multiple-budgets"
    | "multiple-concurrency"
    | "multiple-folds"
    | "multiple-checks"
    | "undeclared-perpetuity"
    | "unbounded-until"
    | "perpetual-check"
    | "perpetual-fold"
    | "perpetual-budget"
    | "perpetual-multistep";
  readonly message: string;
}

/**
 * Pure structural validation of a charter's control refs. Construction is
 * total (any template constructs), so cardinality and coherence rules are
 * checked here — by the Kernel before interpretation, by tests, or by an
 * editor — rather than encoded as constructor type errors.
 *
 * The rules:
 *
 * - **At most one of each positional role.** Multiple `AI.budget`,
 *   `AI.concurrency`, `AI.fold`, or `AI.check` refs are an error: there
 *   is exactly one iteration boundary, so a second fold/check has no
 *   position, and merged budget semantics ("tightest wins"? per-ref
 *   accounting?) would be a silent guess. Say what you mean once.
 * - **At most one halt.** Two `AI.until`s make the run's `Out` a union at
 *   the type level — which member resolved is invisible to the caller —
 *   and `AI.until` + `AI.never` is a contradiction (`never` absorbs into
 *   the union, silently typing a perpetual-declared ring as bounded).
 *   Both are errors. Disjunctive exit conditions belong in one `until`'s
 *   prose, with one resolution type.
 * - **Undeclared perpetuity is a warning.** No halt at all types the loop
 *   `Out = never` — legal, and consumers already hold an unusable
 *   `Effect<never, …>` — but a perpetual ring must say so: `AI.never`
 *   with the health signals that substitute for an exit.
 * - **Unbounded `until` is a warning.** A bounded loop with no budget is
 *   a soft runaway: "goal met" is the exit that might never fire.
 */
export const lint = (
  loop: Process<any, any, any, any, any, any[], any>,
): LintIssue[] => {
  const issues: LintIssue[] = [];
  const refs: any[] = loop.refs;

  const halts = refs.filter(isHalt);
  const budgets = refs.filter(isBudget);

  if (halts.length > 1) {
    const modes = new Set(halts.map((h) => h.mode));
    issues.push(
      modes.size > 1
        ? {
            severity: "error",
            code: "conflicting-halts",
            message: `charter "${loop["~alchemy/Name"]}" declares both AI.until and AI.never — a ring is bounded or perpetual, not both`,
          }
        : {
            severity: "error",
            code: "multiple-halts",
            message: `charter "${loop["~alchemy/Name"]}" declares ${halts.length} halts — fold disjunctive exit conditions into one AI.until with one resolution type`,
          },
    );
  }

  if (halts.length === 0) {
    issues.push({
      severity: "warning",
      code: "undeclared-perpetuity",
      message: `charter "${loop["~alchemy/Name"]}" wires no halt — it is typed perpetual (Out = never); declare AI.never with the health signals that substitute for an exit`,
    });
  }

  if (halts.some((h) => h.mode === "until") && budgets.length === 0) {
    issues.push({
      severity: "warning",
      code: "unbounded-until",
      message: `charter "${loop["~alchemy/Name"]}" has a bounded exit but no AI.budget — "goal met" is the exit that might never fire`,
    });
  }

  // perpetual/goal doctrine (reassess §D): a perpetual ring (AI.never)
  // serves one kernel-default turn per work item; the run machinery
  // (check/fold/budget) is run-scoped and has nothing to bind to.
  // Warnings, not errors, for now: the doctrine is new and existing
  // Flywheel-style fixtures (perpetual + fold + delegates) predate the
  // server/goal split. They harden to errors once those migrate.
  const perpetual = halts.some((h) => h.mode === "never");
  if (perpetual) {
    if (refs.some(isCheck)) {
      issues.push({
        severity: "warning",
        code: "perpetual-check",
        message: `charter "${loop["~alchemy/Name"]}" is perpetual (AI.never) but declares AI.check — a check grades a resolution claim, and a perpetual run never claims. Make it a goal (AI.until) or drop the check.`,
      });
    }
    if (refs.some(isFold)) {
      issues.push({
        severity: "warning",
        code: "perpetual-fold",
        message: `charter "${loop["~alchemy/Name"]}" is perpetual (AI.never) but declares AI.fold — the fold is run-scoped and a perpetual run is a single turn with nothing to carry.`,
      });
    }
    if (budgets.length > 0) {
      issues.push({
        severity: "warning",
        code: "perpetual-budget",
        message: `charter "${loop["~alchemy/Name"]}" is perpetual (AI.never) with an AI.budget — a budget that stops the SERVER is an outage, not an exit. Clarify per-item semantics or move the budget onto the goal the ring dispatches.`,
      });
    }
    // multi-step per-item work with no run boundary: the tell is
    // delegation refs (Agents/Processes) on a perpetual ring — a
    // single default turn can't await a delegate's result meaningfully.
    // Agent/Process terms are CLASSES (typeof "function"), so guard on
    // both object and function — the same footgun isAgent/isProcess fix.
    const delegates = refs.filter((ref) => {
      if (
        (typeof ref !== "object" && typeof ref !== "function") ||
        ref === null
      ) {
        return false;
      }
      const kind = (ref as Record<string, unknown>)["~alchemy/Kind"];
      return kind === "Agent" || kind === "Process";
    });
    if (delegates.length > 0) {
      issues.push({
        severity: "warning",
        code: "perpetual-multistep",
        message: `charter "${loop["~alchemy/Name"]}" is perpetual (AI.never) but delegates to ${delegates.length} agent/process ref(s) — multi-step per-item work has no run boundary. Consider AI.until (a goal run per item), or a deterministic AI.process handler.`,
      });
    }
  }

  for (const [code, count] of [
    ["multiple-budgets", budgets.length],
    ["multiple-concurrency", refs.filter(isConcurrency).length],
    ["multiple-folds", refs.filter(isFold).length],
    ["multiple-checks", refs.filter(isCheck).length],
  ] as const) {
    if (count > 1) {
      issues.push({
        severity: "error",
        code,
        message: `charter "${loop["~alchemy/Name"]}" declares ${count} ${code.slice("multiple-".length)} refs — at most one is allowed`,
      });
    }
  }

  return issues;
};
