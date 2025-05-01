/**
 * Removes common indentation from template literals to make them more readable in code.
 * This allows writing multi-line strings with proper indentation in the source code
 * while removing that indentation in the output string.
 *
 * @example
 * const message = dedent`
 *   This is a multi-line string
 *   that will have its indentation removed.
 *     This line has extra indentation that will be preserved.
 * `;
 * // Result:
 * // "This is a multi-line string
 * // that will have its indentation removed.
 * //   This line has extra indentation that will be preserved."
 */
export function dedent(
  strings: TemplateStringsArray,
  ...values: any[]
): string {
  // Combine the template strings and values
  let result = strings.reduce((acc, str, i) => {
    return acc + str + (values[i] !== undefined ? values[i] : "");
  }, "");

  // Split into lines
  const lines = result.split("\n");

  // Remove the first line if it's empty (common when starting with a newline)
  if (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }

  // Remove the last line if it's empty or only whitespace (common when ending with a backtick)
  if (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  // If there are no lines left, return an empty string
  if (lines.length === 0) {
    return "";
  }

  // Find the minimum indentation level (excluding empty lines)
  const minIndent = lines
    .filter((line) => line.trim().length > 0)
    .reduce((min, line) => {
      const indent = line.match(/^[ \t]*/)?.[0].length || 0;
      return indent < min ? indent : min;
    }, Infinity);

  // Remove the common indentation from each line
  const dedented = lines.map((line) => {
    if (line.trim().length === 0) {
      return "";
    }
    return line.substring(minIndent);
  });

  // Join the lines back together
  return dedented.join("\n");
}
