import * as Effect from "effect/Effect";
import type { Services } from "./Services.ts";

/**
 * A `Fragment` is one rendered unit of a charter's document: a tagged
 * template plus its splices, captured as pure data. Fragments are what
 * {@link prose} constructs and what a charter's TURN effect returns —
 * the kernel renders them into the model's context at every sampling
 * boundary (the "tick").
 *
 * A fragment's splices are the charter's dependency declarations:
 *
 * - a `Tool` / `Skill` / `Agent` term grants that capability for the
 *   tick that rendered it (mention = presence);
 * - a `ToolImpl` (an inline, closure-based tool) grants the tool with
 *   its implementation carried in the splice;
 * - a nested fragment effect (another `AI.prose`, or a component's
 *   turn value) composes documents — each nested fragment is one
 *   BLOCK, the granularity at which the kernel diffs ticks;
 * - plain values render as text.
 *
 * Blocks are the change-detection unit: on the first tick every block
 * freezes into the system prompt; on later ticks any block whose text
 * is not in that frozen head forms the run's SITUATION, delivered as
 * one superseding message when (and only when) it changes.
 */
export interface Fragment {
  readonly "~alchemy/Kind": "Fragment";
  readonly template: TemplateStringsArray;
  readonly refs: ReadonlyArray<unknown>;
}

/**
 * Construct a {@link Fragment}, charging the splices' requirements to
 * the effect's requirement channel — `yield*` (or splice) it and the
 * charter's `Req` accumulates through ordinary Effect typing:
 *
 * ```ts
 * return yield* AI.prose`
 * ${Coding} is your craft; when green, ${OpenPullRequest}.`;
 * // Effect<Fragment, never, Coding | OpenPullRequest>
 * ```
 *
 * The effect itself performs no I/O — construction is pure; the
 * requirements are phantom, resolved by the kernel from the interpret
 * context when the fragment's mentions are compiled. Effect-valued
 * splices (nested `AI.prose`, component turn values) are evaluated by
 * the kernel at render time, every tick.
 */
export const prose = <const Refs extends any[]>(
  template: TemplateStringsArray,
  ...refs: Refs
): Effect.Effect<Fragment, never, Services<Refs>> =>
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
 * return yield* AI.prose`
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
 *   a nested `AI.prose` dedents itself.
 *
 * Applied by the kernel's renderer to every term template (prose,
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
