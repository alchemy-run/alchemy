import React from "react";
import { t } from "./tokens";

/**
 * Small deterministic TypeScript tokenizer for video frames — maps source
 * text to the site's --alc-code-* palette. Not a real parser; tuned for the
 * snippet shapes the storyboards use. (Upgrade path: pre-tokenize with shiki
 * at build time and swap this out — the CodeText contract stays the same.)
 */

type Tok = { text: string; color: string };

const KEYWORDS = new Set([
  "import",
  "export",
  "default",
  "from",
  "const",
  "let",
  "return",
  "function",
  "async",
  "await",
  "yield",
  "new",
  "type",
  "interface",
  "extends",
  "class",
  "as",
]);

const PATTERN =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)|(\s+)|(.)/gm;

export function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let m: RegExpExecArray | null;
  PATTERN.lastIndex = 0;
  while ((m = PATTERN.exec(line)) !== null) {
    const [, comment, str, num, word, ws, other] = m;
    if (comment !== undefined) out.push({ text: comment, color: t.code.comment });
    else if (str !== undefined) out.push({ text: str, color: t.code.string });
    else if (num !== undefined) out.push({ text: num, color: t.code.literal });
    else if (word !== undefined) {
      const rest = line.slice(PATTERN.lastIndex);
      const isCall = rest.startsWith("(") || rest.startsWith("`");
      const color = KEYWORDS.has(word)
        ? t.code.keyword
        : isCall
          ? t.code.fn
          : /^[A-Z]/.test(word)
            ? t.code.variable
            : t.code.variable;
      out.push({ text: word, color });
    } else if (ws !== undefined) out.push({ text: ws, color: t.code.punct });
    else if (other !== undefined) out.push({ text: other, color: t.code.punct });
  }
  return out;
}

/** Renders one highlighted code line, optionally truncated to `chars`. */
export const CodeText: React.FC<{ line: string; chars?: number }> = ({
  line,
  chars,
}) => {
  const visible = chars === undefined ? line : line.slice(0, Math.max(0, chars));
  const toks = tokenize(visible);
  return (
    <>
      {toks.map((tok, i) => (
        <span key={i} style={{ color: tok.color }}>
          {tok.text}
        </span>
      ))}
    </>
  );
};
