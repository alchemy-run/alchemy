import type { Agent } from "./Agent.ts";

/**
 * A control ref that assigns an {@link Agent} the verifier role — the
 * positional judge of the loop's halt condition.
 *
 * The halt names *what* ends a run; the check names *who* judges it. The
 * kernel invokes the check agent at the iteration boundary with the
 * iteration's Trace and the halt condition: the verdict is goal-met (the
 * run resolves) or off-goal with a reason that becomes input to the next
 * iteration. Absent a check, the kernel's default judge policy grades the
 * halt condition itself.
 *
 * This is the maker/checker split applied to the stop condition: the
 * agent that did the work is never the one that decides the work is done.
 * Like the fold, the check is a positional role in the loop runtime — it
 * runs out-of-band at the iteration boundary, not at the model's
 * discretion — and like every ref it is dependency declaration: the check
 * agent's transitive requirements (and any refs nested in the check's own
 * template) flow into the loop's `Req`, while the agent term itself does
 * not.
 *
 * The template is optional — with one, the same agent grades differently
 * per ring; without one, the agent's own template is its instructions.
 *
 * ```ts
 * AI.check(Judge)          // Judge's own template is the grading policy
 * AI.check(Judge)`grade every iteration: run ${Bash} yourself —
 * the worker's claim of done-ness is not a signal`
 * ```
 */
export interface Check<
  A extends Agent<any, any, any, any> = Agent<any, any, any, any>,
  Refs extends any[] = any[],
> {
  "~alchemy/Kind": "Check";
  agent: A;
  template: TemplateStringsArray | undefined;
  refs: Refs;
}

/**
 * Assign `agent` the verifier role. Usable bare (`AI.check(Judge)`) or as
 * a template tag with ring-specific grading instructions
 * (`AI.check(Judge)\`…\``).
 */
export const check = <A extends Agent<any, any, any, any>>(
  agent: A,
): Check<A, []> &
  (<const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => Check<A, Refs>) =>
  Object.assign(
    (template: TemplateStringsArray, ...refs: any[]) =>
      makeCheck(agent, template, refs),
    makeCheck(agent, undefined, []),
  ) as any;

const makeCheck = (
  agent: unknown,
  template: TemplateStringsArray | undefined,
  refs: any[],
): any => ({
  "~alchemy/Kind": "Check",
  agent,
  template,
  refs,
});

export const isCheck = (value: unknown): value is Check<any, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Check";
