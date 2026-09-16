import { renderCode } from "./render.ts";

/**
 * A block of MARKDOWN written inline, dedented to its own margin —
 * and syntax-highlighted as Markdown by the `alchemy-vscode`
 * extension, the same treatment charter prose gets. For the documents
 * that are not a charter: a tool engine's instructions, a rendered
 * report, a comment body.
 *
 * ```ts
 * const teaching = markdown`
 *   Write the BODY of an async function with \`tools\` in scope.
 *
 *   Available capabilities:
 *
 *   ${signatures}
 * `;
 * ```
 *
 * The margin comes from the STATIC parts only, so splicing an
 * unindented block (a generated signature list) never leaves the prose
 * indented; a multi-line splice at the start of a line keeps that
 * line's indentation.
 */
export const markdown = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<unknown>
): string => renderCode(strings, values);
