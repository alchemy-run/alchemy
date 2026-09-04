import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ToolImpl } from "./Tool.ts";

/**
 * A `Fragment` is one rendered unit of a charter's document: a tagged
 * template plus its splices, captured as pure data. Fragments are what
 * {@link fragment} constructs and what a charter's TURN effect returns —
 * the driver renders them into the model's context at every sampling
 * boundary (the "tick").
 *
 * A fragment's splices are the charter's dependency declarations:
 *
 * - a `Tool` / `Skill` / `Agent` term grants that capability for the
 *   tick that rendered it (mention = presence);
 * - a `ToolImpl` (an inline, closure-based tool) grants the tool with
 *   its implementation carried in the splice;
 * - a nested fragment effect (another `AI.fragment`, or a component's
 *   turn value) composes documents — each nested fragment is one
 *   BLOCK, the granularity at which the driver diffs ticks;
 * - plain values render as text.
 *
 * Blocks are the change-detection unit: on the first tick every block
 * freezes into the system prompt; on later ticks any block whose text
 * is not in that frozen head forms the session's SITUATION, delivered as
 * one superseding message when (and only when) it changes.
 */
export interface Fragment<
  Refs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
> {
  readonly "~alchemy/Kind": "Fragment";
  readonly template: TemplateStringsArray;
  /**
   * The splices, with their TYPES retained — mention-is-presence as a
   * type-level fact: a spliced `Tool<Self>` class charges the host
   * Layer's requirement channel, from which `AI.ToolNames` /
   * `AI.ToolInput` read the wire surface (see Agent.ts).
   */
  readonly refs: Refs;
}

/**
 * Construct a {@link Fragment}, charging the splices' requirements to
 * the effect's requirement channel — `yield*` (or splice) it and the
 * charter's `Req` accumulates through ordinary Effect typing:
 *
 * ```ts
 * return yield* AI.fragment`
 * ${Coding} is your craft; when green, ${OpenPullRequest}.`;
 * // Effect<Fragment, never, Coding | OpenPullRequest>
 * ```
 *
 * The effect itself performs no I/O — construction is pure; the
 * requirements are phantom, resolved by the driver from the interpret
 * context when the fragment's mentions are compiled. Effect-valued
 * splices (nested `AI.fragment`, component turn values) are evaluated by
 * the driver at render time, every tick.
 */
export const fragment = <const Refs extends any[]>(
  template: TemplateStringsArray,
  ...refs: Refs
): Effect.Effect<Fragment<Refs>, never, Services<Refs>> =>
  Effect.succeed({
    "~alchemy/Kind": "Fragment",
    template,
    refs,
  } satisfies Fragment) as never;

export const isFragment = (value: unknown): value is Fragment =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Fragment";

/**
 * Strip the common indentation margin from a tagged template's literal
 * parts, so prose can be written indented with the surrounding code:
 *
 * ```ts
 * return yield* AI.fragment`
 *   This process manages issues for ${repo} from open to close.
 *
 *   A ready issue is handed to ${Engineer}.
 * `;
 * ```
 *
 * Rules (à la Kotlin `trimIndent` / TC39 `String.dedent`):
 *
 * - a leading blank first line is dropped;
 * - the margin is the MINIMUM indentation over non-blank lines of the
 *   LITERAL text (a line that runs into a splice counts — the splice
 *   is its content);
 * - relative indentation beyond the margin is preserved (markdown
 *   nesting works);
 * - splice VALUES are never dedented and never influence the margin —
 *   a nested `AI.fragment` dedents itself.
 *
 * Applied by the driver's renderer to every term template (prose,
 * tool/skill/parameter/event descriptions).
 */
export const dedentTemplate = (parts: readonly string[]): readonly string[] => {
  // measure: the whitespace run after every literal newline
  let margin = Number.POSITIVE_INFINITY;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!;
    let at = part.indexOf("\n");
    while (at !== -1) {
      let j = at + 1;
      while (j < part.length && (part[j] === " " || part[j] === "\t")) j++;
      if (j < part.length) {
        // non-blank line: its indent is a margin candidate (blank: skip)
        if (part[j] !== "\n") margin = Math.min(margin, j - at - 1);
      } else if (p < parts.length - 1) {
        // the line continues into a splice — the splice is its content
        margin = Math.min(margin, j - at - 1);
      }
      at = part.indexOf("\n", j);
    }
  }

  const strip =
    Number.isFinite(margin) && margin > 0
      ? new RegExp(`\n[ \t]{1,${margin}}`, "g")
      : undefined;
  return parts.map((part, p) => {
    let text = strip === undefined ? part : part.replace(strip, "\n");
    if (p === 0) text = text.replace(/^[ \t]*\n/, "");
    return text;
  });
};

/**
 * The requirement contributed by a single interpolated ref — its
 * **tag** (or, for effect-valued splices, its requirement channel):
 *
 * - a raw `ToolImpl` (an inline, closure-based tool) contributes its
 *   implementation's own requirements — the impl is inline; there is
 *   no tag to defer to.
 * - a `Tool<Self>`, `Agent<Self>`, or `Skill<Self>` class is a
 *   `Context.Service`; interpolating it contributes the tag itself —
 *   for a skill that means the SKILL's tag, never its tools': the
 *   bundle is nominal and encapsulated, and the tool tags surface
 *   only as the skill LAYER's own requirements
 *   (`Coding.make(): Layer<Coding, never, Grep | …>`).
 *   Transitivity lives in Layer composition, not the type
 *   computation — which is what lets two agents in one runtime hold
 *   different implementations of the same contract.
 * - an `Effect` splice (a nested `AI.fragment`, a component's turn
 *   value, a `Match` over fragment branches) contributes ITS
 *   requirement channel — the `R` union is how conditional branches
 *   accumulate: every capability any branch could mention is a
 *   requirement, whether or not this tick renders it.
 * - everything else (parameters, events, plain values) contributes
 *   nothing.
 *
 * Interpolation is dependency declaration: mentioning a term in a
 * template is what places it in the dependency graph — and NOT
 * mentioning one is what makes capability-by-omission a type-level
 * fact.
 */
export type RefServices<R> =
  R extends ToolImpl<any, any, infer Req>
    ? Req
    : R extends Context.Service<infer Id, any>
      ? Id
      : R extends Effect.Effect<any, any, infer R2>
        ? R2
        : never;

/**
 * Folds a fragment's interpolated expressions into its requirement
 * union (`Req`).
 */
export type Services<Refs extends any[]> = Refs[number] extends infer A
  ? RefServices<A>
  : never;
