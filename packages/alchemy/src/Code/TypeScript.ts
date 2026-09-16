import { renderCode } from "./render.ts";

/**
 * A block of TYPESCRIPT written inline, dedented to its own margin —
 * and syntax-highlighted as TypeScript by the `alchemy-vscode`
 * extension, so generated code reads like code in the editor rather
 * than like a string:
 *
 * ```ts
 * const wrapper = typescript`
 *   const program = (function () {
 *   ${body}
 *   })();
 *   return await Effect.runPromise(program);
 * `;
 * ```
 *
 * The margin comes from the STATIC parts only, so splicing a value
 * that starts at column 0 never leaves the template indented; a
 * multi-line splice at the start of a line keeps that line's
 * indentation. Escapes are RAW (`\n` stays two characters) — what you
 * write is what the emitted source says.
 */
export const typescript = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<unknown>
): string => renderCode(strings, values);
