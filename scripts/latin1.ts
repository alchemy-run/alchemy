// Keep package source Latin-1 only.
//
// V8 keeps every module's source text in the heap, and stores a string at one
// byte per character only while every character is Latin-1. One `—` anywhere
// in a file doubles the memory of the whole file: on Cloudflare Workers a
// single em dash in Output.ts made V8 hold the bundled Durable Object script at
// two bytes per character, 0.5 to 0.8 MB per isolate.
//
//   node scripts/latin1.ts           rewrite package sources to Latin-1
//   node scripts/latin1.ts --check   fail if any package source is not Latin-1
//
// Values stay intact: inside string, template and regex literals a character
// becomes a `\u` escape, and in JSX text or attributes an HTML entity.
// Elsewhere (comments, in practice) typographic punctuation becomes its ASCII
// form and anything else becomes `U+XXXX`. Characters the script can't rewrite
// without changing behavior (identifiers, tagged templates) are reported.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseAst } from "rolldown/parseAst";

class NonLatin1Source extends Data.TaggedError("NonLatin1Source")<{
  readonly message: string;
}> {}

class ParseFailed extends Data.TaggedError("ParseFailed")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

const NON_LATIN1 = /[^\x00-\xff]/;
const NON_LATIN1_ALL = /[^\x00-\xff]/gu;
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

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

type Node = { readonly type: string; readonly start: number; readonly end: number } & Record<
  string,
  unknown
>;

const isNode = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && typeof (value as Node).type === "string";

type Kind = "escape" | "entity" | "unsafe";

interface Range {
  readonly start: number;
  readonly end: number;
  readonly kind: Kind;
}

/** Ranges of the source that are code rather than comments. */
const codeRanges = (code: string, filename: string): Array<Range> => {
  const lang = /\.[cm]?jsx?$/.test(filename) ? "jsx" : filename.endsWith("x") ? "tsx" : "ts";
  const program = parseAst(code, { sourceType: "module", lang }, filename);
  const ranges: Array<Range> = [];
  const visit = (node: unknown, parent: Node | undefined): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (!isNode(node)) return;
    switch (node.type) {
      case "Literal":
        // JSX attribute strings don't process `\` escapes.
        ranges.push({ ...node, kind: parent?.type === "JSXAttribute" ? "entity" : "escape" });
        return;
      case "Directive":
        ranges.push({ ...node, kind: "escape" });
        break;
      case "TemplateElement":
        // A tag reads `strings.raw`, where an escape is no longer the same value.
        ranges.push({ ...node, kind: parent?.type === "TemplateLiteral" ? "escape" : "unsafe" });
        return;
      case "TaggedTemplateExpression":
        visit(node.tag, node);
        visit((node.quasi as Node).expressions, node);
        for (const quasi of (node.quasi as Node).quasis as Array<Node>) {
          ranges.push({ ...quasi, kind: "unsafe" });
        }
        return;
      case "JSXText":
        ranges.push({ ...node, kind: "entity" });
        return;
      case "Identifier":
      case "PrivateIdentifier":
      case "JSXIdentifier":
        // A TS identifier's range also covers its type annotation.
        ranges.push({
          start: node.start,
          end: node.start + (node.name as string).length,
          kind: "unsafe",
        });
        break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (value !== null && typeof value === "object") visit(value, node);
    }
  };
  visit(program, undefined);
  return ranges.sort((a, b) => a.start - b.start);
};

/** `\u` escapes for one code point: two (a surrogate pair) above U+FFFF. */
const escape = (c: string): string =>
  Array.from({ length: c.length }, (_, i) => c.charCodeAt(i))
    .map((u) => `\\u${u.toString(16).padStart(4, "0")}`)
    .join("");

const entity = (c: string): string => `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`;

const describe = (c: string): string =>
  ASCII[c] ?? `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

const lineOf = (code: string, index: number) => code.slice(0, index).split("\n").length;

/** `code` rewritten to Latin-1, plus the lines that can't be rewritten safely. */
const toLatin1 = (code: string, filename: string) => {
  if (!NON_LATIN1.test(code)) return { code, unsafe: [] as Array<number> };
  const ranges = codeRanges(code, filename);
  const unsafe: Array<number> = [];
  let out = "";
  let pos = 0;
  let r = 0;
  for (const match of code.matchAll(NON_LATIN1_ALL)) {
    const i = match.index;
    const c = match[0];
    while (r < ranges.length && ranges[r]!.end <= i) r++;
    // A directive's range holds its literal's, so take the innermost one.
    let range: Range | undefined;
    for (let k = r; k < ranges.length && ranges[k]!.start <= i; k++) {
      if (ranges[k]!.end > i) range = ranges[k];
    }
    out += code.slice(pos, i);
    pos = i + c.length;
    if (range?.kind === "unsafe") {
      unsafe.push(lineOf(code, i));
      out += c;
    } else if (range?.kind === "escape") {
      out += escape(c);
    } else if (range?.kind === "entity") {
      out += entity(c);
    } else {
      const ascii = describe(c);
      // `*\u200b/` spells `*/` inside a block comment without closing it; a
      // soft hyphen (Latin-1, and invisible) does the same job.
      out += (out.slice(-1) + ascii + code.charAt(pos)).includes("*/") ? "\u00ad" : ascii;
    }
  }
  return { code: out + code.slice(pos), unsafe };
};

const command = Command.make(
  "latin1",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Fail if any package source contains a non-Latin-1 character"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ check }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");
    const packages = path.join(root, "packages");

    const files: Array<string> = [];
    for (const name of (yield* fs.readDirectory(packages)).sort()) {
      const src = path.join(packages, name, "src");
      if (!(yield* fs.exists(src))) continue;
      for (const entry of yield* fs.readDirectory(src, { recursive: true })) {
        const segments = entry.split(path.sep);
        if (segments.includes("node_modules") || segments.includes("fixtures")) continue;
        if (!EXTENSIONS.test(entry) || /\.test\.[cm]?[jt]sx?$/.test(entry)) continue;
        files.push(path.join(src, entry));
      }
    }

    const offenders: Array<string> = [];
    const unsafe: Array<string> = [];
    let rewritten = 0;
    for (const file of files) {
      const code = yield* fs.readFileString(file);
      if (!NON_LATIN1.test(code)) continue;
      const relative = path.relative(root, file);
      if (check) {
        const first = code.search(NON_LATIN1);
        const cp = code.codePointAt(first)!.toString(16).toUpperCase().padStart(4, "0");
        offenders.push(`${relative}:${lineOf(code, first)} U+${cp}`);
        continue;
      }
      const result = yield* Effect.try({
        try: () => toLatin1(code, file),
        catch: (cause) => new ParseFailed({ path: relative, cause }),
      });
      for (const line of result.unsafe) unsafe.push(`${relative}:${line}`);
      if (result.code !== code) {
        yield* fs.writeFileString(file, result.code);
        rewritten++;
      }
    }

    if (check) {
      if (offenders.length === 0) return;
      for (const offender of offenders) yield* Console.error(offender);
      return yield* new NonLatin1Source({
        message: `${offenders.length} package source files contain non-Latin-1 characters; run \`pnpm latin1:fix\``,
      });
    }
    yield* Console.log(`Rewrote ${rewritten} files to Latin-1`);
    if (unsafe.length > 0) {
      for (const line of unsafe) yield* Console.error(line);
      return yield* new NonLatin1Source({
        message: `${unsafe.length} characters sit in identifiers or tagged templates; rewrite them by hand`,
      });
    }
  }),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
