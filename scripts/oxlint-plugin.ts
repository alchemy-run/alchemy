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
// attributes an HTML entity. Elsewhere (comments, in practice) typographic
// punctuation becomes its ASCII form and anything else becomes `U+XXXX`.
// Identifiers and tagged templates are reported without a fix, since escaping
// them changes behavior.

// oxlint doesn't export its plugin types, so these cover what the rule uses.
interface Node {
  readonly type: string;
  readonly range: readonly [number, number];
  readonly parent?: Node;
  readonly name?: string;
  readonly quasi?: Node & { readonly quasis: ReadonlyArray<Node> };
}

interface Fixer {
  replaceTextRange(range: readonly [number, number], text: string): unknown;
}

interface Context {
  readonly sourceCode: { readonly text: string };
  report(descriptor: {
    readonly loc: { readonly start: Position; readonly end: Position };
    readonly message: string;
    readonly fix?: (fixer: Fixer) => unknown;
  }): void;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

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

type Kind = "escape" | "entity" | "unsafe";

interface Range {
  readonly start: number;
  readonly end: number;
  readonly kind: Kind;
}

/** `\u` escapes for one code point: two (a surrogate pair) above U+FFFF. */
const escape = (c: string): string =>
  Array.from({ length: c.length }, (_, i) => c.charCodeAt(i))
    .map((u) => `\\u${u.toString(16).padStart(4, "0")}`)
    .join("");

const entity = (c: string): string => `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`;

const codePoint = (c: string): string =>
  `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

const position = (code: string, index: number): Position => {
  const before = code.slice(0, index);
  const line = before.split("\n").length;
  return { line, column: index - (before.lastIndexOf("\n") + 1) };
};

const latin1 = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: { description: "Keep package source Latin-1 so V8 stores it at one byte per character" },
  },
  create(context: Context) {
    const code = context.sourceCode.text;
    if (!NON_LATIN1.test(code)) return {};

    const ranges: Array<Range> = [];
    const add = (node: Node, kind: Kind) =>
      ranges.push({ start: node.range[0], end: node.range[1], kind });
    // A TS identifier's range also covers its type annotation.
    const addName = (node: Node) =>
      ranges.push({
        start: node.range[0],
        end: node.range[0] + (node.name ?? "").length,
        kind: "unsafe",
      });

    return {
      // JSX attribute strings don't process `\` escapes.
      Literal: (node: Node) =>
        add(node, node.parent?.type === "JSXAttribute" ? "entity" : "escape"),
      // A tag reads `strings.raw`, where an escape is no longer the same value.
      TemplateElement: (node: Node) =>
        add(node, node.parent?.parent?.type === "TaggedTemplateExpression" ? "unsafe" : "escape"),
      JSXText: (node: Node) => add(node, "entity"),
      Identifier: addName,
      PrivateIdentifier: addName,
      JSXIdentifier: addName,
      "Program:exit": () => {
        for (const match of code.matchAll(NON_LATIN1_ALL)) {
          const i = match.index;
          const c = match[0];
          // Literals don't nest, so the last range starting at or before `i` is the one.
          let range: Range | undefined;
          for (const candidate of ranges) {
            if (candidate.start <= i && i < candidate.end) range = candidate;
          }
          const loc = { start: position(code, i), end: position(code, i + c.length) };
          const message = `${codePoint(c)} is not Latin-1, so V8 stores this whole module at two bytes per character`;
          if (range?.kind === "unsafe") {
            context.report({
              loc,
              message: `${message}. Rewrite it by hand: escaping it here changes behavior.`,
            });
            continue;
          }
          let text: string;
          if (range?.kind === "escape") text = escape(c);
          else if (range?.kind === "entity") text = entity(c);
          else {
            text = ASCII[c] ?? codePoint(c);
            // `*​/` spells `*/` inside a block comment without closing it; a
            // soft hyphen (Latin-1, and invisible) does the same job.
            if ((code.charAt(i - 1) + text + code.charAt(i + c.length)).includes("*/")) {
              text = "­";
            }
          }
          context.report({
            loc,
            message,
            fix: (fixer) => fixer.replaceTextRange([i, i + c.length], text),
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "alchemy" },
  rules: { latin1 },
};
