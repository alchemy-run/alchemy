import { isBudget, isConcurrency } from "./Budget.ts";
import { isCheck } from "./Check.ts";
import { isFold } from "./Fold.ts";
import { isHalt } from "./Halt.ts";
import type { Loop } from "./Loop.ts";

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
    | "unbounded-until";
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
  loop: Loop<any, any, any, any, any, any[], any>,
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
