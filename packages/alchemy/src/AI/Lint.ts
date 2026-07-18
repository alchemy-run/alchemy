import { isConcurrency } from "./Budget.ts";
import { isCheck } from "./Check.ts";
import { isFold } from "./Fold.ts";
import { isHalt } from "./Signature.ts";
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
    | "multiple-concurrency"
    | "multiple-folds"
    | "multiple-checks"
    | "undeclared-perpetuity"
    | "perpetual-check"
    | "perpetual-fold"
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
 * - **At most one of each positional role.** Multiple `AI.concurrency`,
 *   `AI.fold`, or `AI.check` refs are an error: there is exactly one
 *   iteration boundary, so a second fold/check has no position. Say
 *   what you mean once. (Budgets are no longer charter refs — they are
 *   provided as a Layer via `AI.budget({...})`, and the kernel always
 *   enforces some ceiling, so there is no budget cardinality to lint.)
 * - **At most one halt.** Two halts make the run's `Out` a union at
 *   the type level — which member resolved is invisible to the caller —
 *   and a bounded halt + `AI.never` is a contradiction (`never` absorbs
 *   into the union, silently typing a perpetual-declared ring as
 *   bounded). Both are errors. Disjunctive exit conditions belong in one
 *   halt (one `until`'s prose, or one `AI.exit(AI.when(A, B))`), with
 *   one resolution type.
 * - **Undeclared perpetuity is a warning.** No halt at all types the loop
 *   `Out = never` — legal, and consumers already hold an unusable
 *   `Effect<never, …>` — but a perpetual ring must say so: `AI.never`
 *   with the health signals that substitute for an exit.
 */
export const lint = (
  loop: Process<any, any, any, any, any, any[], any, any>,
): LintIssue[] => {
  const issues: LintIssue[] = [];
  const refs: any[] = loop.refs;

  const halts = refs.filter(isHalt);

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
