import { dedent } from "../Util/dedent.ts";

/** Marks a splice while the static parts are being dedented. */
const SENTINEL = "\u0000";

/**
 * Render a code template: strip the margin the SOURCE indentation
 * added, then splice the values in.
 *
 * The margin is taken from the template's STATIC parts only. A naive
 * `dedent\`…${value}…\`` takes its margin from the interpolated value
 * too, so splicing anything that starts at column 0 (a generated
 * signature, a model's code) silently leaves the surrounding template
 * indented. Here a splice can never lower the margin.
 *
 * A multi-line value spliced at the start of a line keeps that line's
 * indentation on its continuation lines, so nesting a block inside an
 * indented template reads correctly. Spliced mid-line, a value goes in
 * verbatim.
 */
export const renderCode = (
  strings: TemplateStringsArray,
  values: ReadonlyArray<unknown>,
): string => {
  const marked = strings.raw.reduce(
    (text, part, index) =>
      index === 0 ? part : `${text}${SENTINEL}${index - 1}${SENTINEL}${part}`,
    "",
  );
  return dedent(marked).replace(
    /(^[ \t]*)?\u0000(\d+)\u0000/gm,
    (_match, indent: string | undefined, index: string) => {
      const value = String(values[Number(index)] ?? "");
      return indent === undefined
        ? value
        : indent + value.split("\n").join(`\n${indent}`);
    },
  );
};
