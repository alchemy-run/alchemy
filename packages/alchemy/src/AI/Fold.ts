import type { Agent } from "./Agent.ts";

/**
 * A control ref that assigns an {@link Agent} a positional role in the loop
 * runtime: after each iteration — successful or not — the fold agent is
 * invoked by the kernel (not by the model) with the iteration's Trace and
 * the carried state, and its output becomes the new carried state.
 *
 * The fold is the unit of both memory and durability: compressing an
 * iteration's history into carried state is simultaneously the memory
 * strategy (compaction, observational memory, note-taking) and the
 * durability checkpoint (what survives eviction).
 *
 * This is distinct from interpolating the agent in prose: `${Scribe}` in a
 * charter is in-band delegation (the body may call Scribe mid-iteration, at
 * the model's discretion); `AI.fold(Scribe)` runs out-of-band at the
 * iteration boundary, even when the body crashed.
 *
 * The template is optional — with one, the same agent folds differently per
 * ring; without one, the agent's own template is its instructions. A loop
 * with no fold carries nothing between iterations (Ralph semantics: the
 * repo and the artifacts are the only memory).
 *
 * ```ts
 * AI.fold(Scribe)          // Scribe's own template is the fold policy
 * AI.fold(Scribe)`distill lessons into .alchemy/NOTES.md after
 * every iteration, successful or not`
 * ```
 */
export interface Fold<
  A extends Agent<any, any, any, any> = Agent<any, any, any, any>,
  Refs extends any[] = any[],
> {
  "~alchemy/Kind": "Fold";
  agent: A;
  template: TemplateStringsArray | undefined;
  refs: Refs;
}

/**
 * Assign `agent` the fold role. Usable bare (`AI.fold(Scribe)`) or as a
 * template tag with ring-specific instructions (`AI.fold(Scribe)\`…\``).
 */
export const fold = <A extends Agent<any, any, any, any>>(
  agent: A,
): Fold<A, []> &
  (<const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => Fold<A, Refs>) =>
  Object.assign(
    (template: TemplateStringsArray, ...refs: any[]) =>
      makeFold(agent, template, refs),
    makeFold(agent, undefined, []),
  ) as any;

const makeFold = (
  agent: unknown,
  template: TemplateStringsArray | undefined,
  refs: any[],
): any => ({
  "~alchemy/Kind": "Fold",
  agent,
  template,
  refs,
});

export const isFold = (value: unknown): value is Fold<any, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Fold";
