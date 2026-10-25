/**
 * Cuts a snippet file down to what the slide shows:
 * - only the lines between `// #region show` and `// #endregion show`
 * - `/*hide*\/ … /*end*\/` spans removed (code that type-checks but isn't worth showing)
 * - `// @slide code` shown as `code` (a stand-in line, e.g. an import path)
 */
export const cut = (text: string): string => {
  const start = text.indexOf("// #region show");
  const end = text.indexOf("// #endregion show");
  if (start < 0 || end < 0) throw new Error("snippet has no `// #region show` block");
  const body = text
    .slice(text.indexOf("\n", start) + 1, end)
    .replace(/\s*\/\*hide\*\/[\s\S]*?\/\*end\*\//g, "")
    .replace(/^(\s*)\/\/ @slide (.*)$/gm, "$1$2");
  const lines = body.replace(/\s+$/, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
};

/** The 0-based line and column of the first occurrence of `text`. */
export const locate = (code: string, text: string) => {
  const at = code.indexOf(text);
  if (at < 0) throw new Error(`${JSON.stringify(text)} is not in the code`);
  const before = code.slice(0, at);
  const line = before.split("\n").length - 1;
  return { line, col: at - (before.lastIndexOf("\n") + 1), len: text.length };
};
