/**
 * Resolves `intro/steps.ts` into `out/capture/intro/intro.json` for Remotion:
 *
 * - type-checks every file in `snippets/` with the real compiler: normal
 *   files must pass; `*.error.ts` files must fail, and their error is shown
 * - cuts each snippet down to its `// #region` blocks
 * - highlights code with Shiki (VS Code's Dark+ colours)
 * - turns text anchors for marks, tints and errors into line/column ranges
 *
 *   pnpm intro:build
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHighlighter } from "shiki";
import { API } from "tsgo/unstable/sync";
import type { CodeError, CodeStep, IntroJson, IntroStep, Mark, Token } from "../shared/intro.ts";
import { steps, type CodeSpec, type Find } from "./steps.ts";

const root = path.resolve(import.meta.dirname, "..");
const snippetsDir = path.join(import.meta.dirname, "snippets");
const out = path.join(root, "out", "capture", "intro");

// ── type-check the snippets ──────────────────────────────────────────────
// With the tsgo 7.1 nightly's API: open the snippets project in a snapshot
// and read each file's diagnostics (needs Node; the API's sync channel
// doesn't run under Bun).
interface Diagnostic {
  line: number;
  col: number;
  code: string;
  message: string[];
}
interface Chain {
  text: string;
  messageChain?: Chain[];
}
const flatten = (chain: Chain, depth = 0): string[] => [
  chain.text,
  ...(chain.messageChain ?? []).flatMap((child) => flatten(child, depth + 1)),
];

// Type-checking is the slow part; skip it when no snippet changed since the last build.
const cacheFile = path.join(out, "diagnostics.json");
const snippetNames = (await readdir(snippetsDir)).filter((f) => f.endsWith(".ts") || f === "tsconfig.json");
const stamp = (await Promise.all(snippetNames.map(async (f) => `${f}:${(await stat(path.join(snippetsDir, f))).mtimeMs}`))).join("|");
const cached = await readFile(cacheFile, "utf8").then((t) => JSON.parse(t) as { stamp: string; diagnostics: [string, Diagnostic[]][] }, () => undefined);
const diagnostics = new Map<string, Diagnostic[]>(cached?.stamp === stamp ? cached.diagnostics : []);
if (cached?.stamp !== stamp) {
console.log("● type-checking intro/snippets (tsgo)");
const api = new API({ cwd: snippetsDir });
const configFile = path.join(snippetsDir, "tsconfig.json");
const snapshot = api.createSnapshot({ openProjects: [configFile] });
const project = snapshot.getConfiguredProject(configFile);
if (!project) throw new Error("could not open intro/snippets/tsconfig.json");
for (const file of (await readdir(snippetsDir)).filter((f) => f.endsWith(".ts"))) {
  const full = path.join(snippetsDir, file);
  const list = [
    ...project.program.getSyntacticDiagnostics(full),
    ...project.program.getSemanticDiagnostics(full),
  ] as unknown as (Chain & { code: number; startPosition: { line: number; character: number } })[];
  diagnostics.set(
    file,
    list.map((d) => ({
      line: d.startPosition.line,
      col: d.startPosition.character,
      code: `TS${d.code}`,
      message: flatten(d),
    })),
  );
}
api.close();
await mkdir(out, { recursive: true });
await writeFile(cacheFile, JSON.stringify({ stamp, diagnostics: [...diagnostics] }));
}

const snippetFiles = (await readdir(snippetsDir)).filter((f) => f.endsWith(".ts"));
for (const file of snippetFiles) {
  const list = diagnostics.get(file) ?? [];
  const errorFile = file.endsWith(".error.ts");
  if (errorFile && list.length === 0) throw new Error(`${file} is expected to fail type-checking, but it passes`);
  if (!errorFile && list.length > 0) {
    throw new Error(`${file} must type-check:\n${list.map((d) => `  ${d.line + 1}:${d.col + 1} ${d.message.join("\n    ")}`).join("\n")}`);
  }
}

// ── snippets: keep only the named regions ────────────────────────────────
const REGION = /^\s*\/\/ #(end)?region\b/;
/** Code that must be there to type-check but isn't worth showing: `/*hide*\/ … /*end*\/`. */
const HIDDEN = /\/\*hide\*\/.*?\/\*end\*\//g;
interface Cut {
  code: string;
  /** Snippet line (0-based) of each kept line. */
  origin: number[];
  regions: Map<string, [number, number]>;
}
const cut = (text: string, keep?: string[]): Cut => {
  const lines = text.split("\n");
  const open: string[] = [];
  const kept: string[] = [];
  const origin: number[] = [];
  const regions = new Map<string, [number, number]>();
  const starts = new Map<string, number>();
  lines.forEach((line, i) => {
    const marker = line.match(/^\s*\/\/ #(end)?region\s+(\S+)/);
    if (marker) {
      const name = marker[2]!;
      if (marker[1]) {
        open.splice(open.lastIndexOf(name), 1);
        regions.set(name, [starts.get(name)!, kept.length - 1]);
      } else {
        open.push(name);
        starts.set(name, kept.length);
      }
      return;
    }
    if (REGION.test(line)) return;
    if (keep && !keep.some((name) => open.includes(name))) return;
    kept.push(line.replace(HIDDEN, ""));
    origin.push(i);
  });
  // Drop the shared indentation and blank edges.
  while (kept.length && !kept[0]!.trim()) (kept.shift(), origin.shift());
  while (kept.length && !kept.at(-1)!.trim()) (kept.pop(), origin.pop());
  return { code: kept.join("\n"), origin, regions };
};

// ── highlighting ─────────────────────────────────────────────────────────
const highlighter = await createHighlighter({ themes: ["dark-plus"], langs: ["typescript", "yaml"] });
const PSEUDO_KEYWORDS: Record<string, string> = { construct: "#a3c473", runtime: "#e0a86b" };
const tokenize = (code: string, pseudo: boolean, lang: "typescript" | "yaml" | "ansi" = "typescript"): Token[][] =>
  highlighter.codeToTokens(code, { lang, theme: "dark-plus" }).tokens.map((line) =>
    line.flatMap((token) => {
      // Shiki's FontStyle.Bold is bit 2 (terminal output uses it).
      const bold = ((token.fontStyle ?? 0) & 2) !== 0 || undefined;
      if (!pseudo) return [{ text: token.content, color: token.color ?? "#d4d4d4", ...(bold ? { bold } : {}) }];
      // The imagined language's own keywords.
      return token.content.split(/\b(construct|runtime)\b/).flatMap((text, i) =>
        text ? [{ text, color: i % 2 ? PSEUDO_KEYWORDS[text]! : (token.color ?? "#d4d4d4") }] : [],
      );
    }),
  );

// ── anchors ──────────────────────────────────────────────────────────────
const locate = (code: string, find: Find, title: string) => {
  const { text, nth = 1 } = typeof find === "string" ? { text: find } : find;
  let at = -1;
  for (let i = 0; i < nth; i++) {
    at = code.indexOf(text, at + 1);
    if (at < 0) throw new Error(`step "${title}": ${JSON.stringify(text)} not found (occurrence ${i + 1})`);
  }
  const before = code.slice(0, at);
  const line = before.split("\n").length - 1;
  return { line, col: at - (before.lastIndexOf("\n") + 1), len: text.length };
};

/** `split`: shown as one of two side-by-side panes, so it gets half the width. */
const resolveCode = async (spec: CodeSpec, split = false): Promise<CodeStep> => {
  let code: string;
  let raw: string | undefined;
  let regions = new Map<string, [number, number]>();
  let error: CodeError | undefined;
  if ("snippet" in spec.src) {
    const file = path.join(snippetsDir, spec.src.snippet);
    const text = await readFile(file, "utf8");
    const c = cut(text, spec.src.regions);
    code = c.code;
    regions = c.regions;
    const list = diagnostics.get(spec.src.snippet) ?? [];
    if (spec.src.snippet.endsWith(".error.ts") && !spec.error?.hide) {
      const d = list[0]!;
      const line = c.origin.indexOf(d.line);
      if (line < 0) throw new Error(`step "${spec.title}": the error is outside the shown regions`);
      const shown = spec.error?.pick ? spec.error.pick(d.message) : d.message.slice(0, 2);
      // Underline to the end of the error's line, like the editor's squiggle.
      const lineText = code.split("\n")[line]!;
      const indent = (text.split("\n")[d.line]!.length - text.split("\n")[d.line]!.trimStart().length) -
        (lineText.length - lineText.trimStart().length);
      const col = Math.max(0, d.col - indent);
      error = { line, col, len: Math.max(1, lineText.length - col), code: d.code, message: shown };
    }
  } else {
    code = spec.src.code;
  }
  // Terminal output: marks and sizing work on the text as shown, without escapes.
  if (spec.lang === "ansi") {
    raw = code;
    code = code.replace(/\x1b\[[0-9;]*m/g, "");
  }
  const lineOf = (find: Find) => locate(code, find, spec.title).line;
  const tints = (spec.tints ?? []).map((tint) => {
    if ("region" in tint) {
      const r = regions.get(tint.region);
      if (!r) throw new Error(`step "${spec.title}": no region ${tint.region}`);
      return { from: r[0], to: r[1], tone: tint.tone };
    }
    const from = lineOf(tint.from);
    return { from, to: tint.to ? lineOf(tint.to) : from, tone: tint.tone };
  });
  const marks: Mark[] = (spec.marks ?? []).map((mark) => {
    const at = locate(code, mark.find, spec.title);
    return {
      kind: mark.kind,
      ...at,
      ...(mark.to ? { toLine: lineOf(mark.to) } : {}),
      label: mark.label,
      side: mark.side,
      tone: mark.tone,
      arrow: mark.arrow,
    };
  });
  const lines = tokenize(raw ?? code, !!spec.pseudo, spec.lang);
  const beside = spec.beside
    ? await resolveCode({ kind: "code", title: spec.title, group: spec.group, ...spec.beside }, true)
    : undefined;
  const besideCode = beside?.lines.map((l) => l.map((t) => t.text).join("")).join("\n") ?? "";
  const links = (spec.links ?? []).map((link) => ({
    from: locate(code, link.from, spec.title),
    to: locate(besideCode, link.to, spec.title),
    tone: link.tone,
  }));
  const longest = Math.max(...code.split("\n").map((l) => l.length));
  // Fit the code: at most 30px, smaller for long files, larger for short snippets.
  const available = split || spec.beside ? 760 : spec.panel || spec.drill || spec.req ? 1060 : 1560;
  const fontSize =
    spec.fontSize ?? Math.max(18, Math.min(34, Math.floor(available / (longest * 0.6)), Math.floor(780 / (lines.length * 1.55))));
  return {
    kind: "code",
    title: spec.title,
    notes: spec.notes ?? "",
    group: spec.group,
    file: spec.file,
    pseudo: spec.pseudo,
    lines,
    fontSize,
    tints,
    focus: spec.focus ? { from: lineOf(spec.focus.from), to: lineOf(spec.focus.to ?? spec.focus.from) } : undefined,
    marks,
    error,
    panel: spec.panel,
    diagram: spec.diagram,
    drill: spec.drill,
    req: spec.req,
    beside,
    links: links.length ? links : undefined,
    aside: spec.aside,
    quiet: spec.quiet,
    frames: spec.frames ?? 30,
  };
};

const resolved: IntroStep[] = [];
for (const spec of steps) {
  if (spec.kind === "code") resolved.push(await resolveCode(spec));
  else if (spec.kind === "slide") {
    resolved.push({
      kind: "slide",
      title: spec.title,
      notes: spec.notes ?? "",
      layout: spec.layout ?? "section",
      eyebrow: spec.eyebrow,
      heading: spec.heading,
      subtitle: spec.subtitle,
      frames: spec.frames ?? 60,
    });
  } else {
    resolved.push({ ...spec, notes: spec.notes ?? "", frames: spec.frames ?? 60 });
  }
}

// One size per sequence: a snippet keeps its size as panels and marks come and go.
const groupSize = new Map<string, number>();
steps.forEach((spec, i) => {
  const step = resolved[i]!;
  if (spec.kind !== "code" || step.kind !== "code" || spec.fontSize) return;
  groupSize.set(step.group, Math.min(groupSize.get(step.group) ?? Infinity, step.fontSize, step.beside?.fontSize ?? Infinity));
});
steps.forEach((spec, i) => {
  const step = resolved[i]!;
  if (spec.kind === "code" && step.kind === "code" && !spec.fontSize) {
    step.fontSize = groupSize.get(step.group)!;
    if (step.beside) step.beside.fontSize = step.fontSize;
  }
});

await mkdir(out, { recursive: true });
const json: IntroJson = { steps: resolved };
// Images the steps reference (e.g. an aside's photo), served next to intro.json.
await cp(path.join(import.meta.dirname, "assets"), path.join(out, "assets"), { recursive: true });
await writeFile(path.join(out, "intro.json"), `${JSON.stringify(json, null, 2)}\n`);
console.log(`✔ ${resolved.length} intro steps → out/capture/intro/intro.json`);
