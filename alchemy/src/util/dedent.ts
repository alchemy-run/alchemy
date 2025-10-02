/**
 * Tagged template literal for removing indentation from a block of text.
 *
 * If the first line is empty, it will be ignored.
 */
export function dedent(strings: TemplateStringsArray, ...values: unknown[]) {
  // Convert template literal arguments back to a regular string
  const raw = String.raw({ raw: strings }, ...values);
  // Split the string by lines
  let lines = raw.split("\n");

  // Remove leading blank lines
  while (lines.length > 0 && lines[0].trim() === "") {
    lines = lines.slice(1);
  }

  // Remove trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines = lines.slice(0, lines.length - 1);
  }

  // If no content lines remain, return empty string
  if (lines.length === 0) {
    return "";
  }

  // Find the minimum-length indent from content lines (non-blank lines)
  let minIndentLength = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() !== "") {
      const indent = line.match(/^[ \t]*/)?.[0];
      if (indent != null && indent.length < minIndentLength) {
        minIndentLength = indent.length;
      }
    }
  }

  // If no indentation found, return lines as-is
  if (minIndentLength === Number.POSITIVE_INFINITY) {
    return lines.join("\n");
  }

  // Remove indent from all lines, preserving blank lines
  lines = lines.map((line) => {
    if (line.trim() === "") {
      return line; // Preserve blank lines
    }
    return line.startsWith(" ".repeat(minIndentLength)) ||
      line.startsWith("\t".repeat(minIndentLength))
      ? line.substring(minIndentLength)
      : line;
  });

  return lines.join("\n");
}
