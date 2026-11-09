// Alchemy's oxlint rules, loaded through `jsPlugins` in oxlint.config.ts.
//
// `alchemy/latin1`: package source stays Latin-1 only. V8 keeps every module's
// source text in the heap, and stores a string at one byte per character only
// while every character is Latin-1. One `—` anywhere in a file doubles the
// memory of the whole file: on Cloudflare Workers a single em dash in Output.ts
// made V8 hold the bundled Durable Object script at two bytes per character,
// 0.5 to 0.8 MB per isolate.
//
// `pnpm lint --fix` rewrites without changing values: inside string, template
// and regex literals a character becomes a `\u` escape, and in JSX text or
// attributes an HTML entity. In comments typographic punctuation becomes its
// ASCII form and anything else becomes `U+XXXX`. Anywhere else (identifiers,
// tagged templates) is reported without a fix, since escaping changes behavior.
import { definePlugin, defineRule } from "@oxlint/plugins";

// eslint-disable-next-line no-control-regex
const NON_LATIN1 = /[^\x00-\xff]/;
// eslint-disable-next-line no-control-regex
const NON_LATIN1_ALL = /[^\x00-\xff]/gu;

/** ASCII forms for the characters that show up in comments. */
const ASCII: Record<string, string> = {
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "--",
  "―": "--",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "•": "*",
  "…": "...",
  "′": "'",
  "″": '"',
  "‹": "<",
  "›": ">",
  "™": "(TM)",
  "←": "<-",
  "↑": "^",
  "→": "->",
  "↓": "v",
  "↔": "<->",
  "⇄": "<->",
  "⇒": "=>",
  "⇔": "<=>",
  "−": "-",
  "≈": "~",
  "≠": "!=",
  "≤": "<=",
  "≥": ">=",
  "∪": "U",
  "─": "-",
  "━": "-",
  "│": "|",
  "┃": "|",
  "┊": "|",
  "┌": "+",
  "┐": "+",
  "└": "+",
  "┘": "+",
  "├": "+",
  "┤": "+",
  "┬": "+",
  "┴": "+",
  "┼": "+",
  "═": "=",
  "║": "|",
  "╔": "+",
  "╗": "+",
  "╚": "+",
  "╝": "+",
  "╠": "+",
  "╣": "+",
  "▶": ">",
  "▸": ">",
  "▼": "v",
  "✓": "ok",
  "✗": "x",
  " ": " ",
  "​": "",
  "‍": "",
  "︎": "",
  "️": "",
  "﻿": "",
};

type Kind = "string" | "jsx" | "comment";

interface FixableRange {
  readonly start: number;
  readonly end: number;
  readonly kind: Kind;
}

/** `\u` escapes for one code point: two (a surrogate pair) above U+FFFF. */
const escape = (c: string): string =>
  Array.from({ length: c.length }, (_, i) => c.charCodeAt(i))
    .map((u) => `\\u${u.toString(16).padStart(4, "0")}`)
    .join("");

const codePoint = (c: string): string =>
  `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

const MESSAGE = "is not Latin-1, so V8 stores this whole module at two bytes per character";

const latin1 = defineRule({
  meta: {
    type: "problem",
    fixable: "code",
    docs: { description: "Keep source Latin-1 so V8 stores it at one byte per character" },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    const text = source.text;
    if (!source.hasBOM && !NON_LATIN1.test(text)) return {};

    const ranges: Array<FixableRange> = source
      .getAllComments()
      .map((comment) => ({ start: comment.range[0], end: comment.range[1], kind: "comment" }));
    const add = (range: readonly [number, number], kind: Kind) =>
      ranges.push({ start: range[0], end: range[1], kind });

    return {
      // JSX attribute strings don't process `\` escapes.
      Literal: (node) => add(node.range, node.parent.type === "JSXAttribute" ? "jsx" : "string"),
      // A tag reads `strings.raw`, where an escape is no longer the same value.
      TemplateElement: (node) => {
        if (node.parent.parent?.type !== "TaggedTemplateExpression") add(node.range, "string");
      },
      JSXText: (node) => add(node.range, "jsx"),
      "Program:exit": () => {
        if (source.hasBOM) {
          context.report({
            loc: { line: 1, column: 0 },
            message: `U+FEFF (byte order mark) ${MESSAGE}`,
            fix: (fixer) => fixer.replaceTextRange([-1, 0], ""),
          });
        }
        ranges.sort((a, b) => a.start - b.start);
        let r = 0;
        for (const match of text.matchAll(NON_LATIN1_ALL)) {
          const start = match.index;
          const c = match[0];
          const end = start + c.length;
          while (r < ranges.length && ranges[r]!.end <= start) r++;
          const range = ranges[r];
          const kind = range && range.start <= start && end <= range.end ? range.kind : undefined;

          let replacement: string | undefined;
          if (kind === "string") replacement = escape(c);
          else if (kind === "jsx")
            replacement = `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`;
          else if (kind === "comment") {
            replacement = ASCII[c] ?? codePoint(c);
            // `*​/` spells `*/` inside a block comment without closing it;
            // a soft hyphen (Latin-1, and invisible) does the same job.
            if ((text.charAt(start - 1) + replacement + text.charAt(end)).includes("*/")) {
              replacement = "­";
            }
          }

          context.report({
            loc: { start: source.getLocFromIndex(start), end: source.getLocFromIndex(end) },
            message:
              replacement === undefined
                ? `${codePoint(c)} ${MESSAGE}. Rewrite it by hand: escaping it here changes behavior.`
                : `${codePoint(c)} ${MESSAGE}`,
            ...(replacement === undefined
              ? {}
              : { fix: (fixer) => fixer.replaceTextRange([start, end], replacement) }),
          });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "alchemy" },
  rules: { latin1 },
});
