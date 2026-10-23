/**
 * Cross-file lookups. An oxlint JS rule sees one file's AST, so rules that
 * need a second file (a command's `rejects`, the kind of an imported class,
 * the stories of a package) read that file's text and scan it. The scans are
 * deliberately simple: they understand the shapes the alchemy-domain skill
 * prescribes (`export class X extends Domain.Y(...)`), not every program.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { KINDS, type Kind, isRelative } from "./ast.ts";

const TTL_MS = 5_000;

interface Cached<A> {
  readonly at: number;
  readonly value: A;
}

const cached = <A>(cache: Map<string, Cached<A>>, key: string, compute: () => A): A => {
  const now = performance.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = compute();
  cache.set(key, { at: now, value });
  return value;
};

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

export const exists = isFile;

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** The file a relative import resolves to, or `undefined` (package imports are not followed). */
export const resolveImport = (importer: string, source: string): string | undefined => {
  if (!isRelative(source)) return undefined;
  const base = path.resolve(path.dirname(importer), source);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  return candidates.find(isFile);
};

const packageRoots = new Map<string, Cached<string | undefined>>();

/** The nearest directory above `file` with a `package.json`. */
export const packageRoot = (file: string): string | undefined =>
  cached(packageRoots, path.dirname(file), () => {
    let dir = path.dirname(file);
    for (;;) {
      if (isFile(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  });

/** What one module declares, read from its text. */
export interface ModuleIndex {
  /** Exported building blocks by name. */
  readonly kinds: ReadonlyMap<string, Kind>;
  /** A command's `rejects: [...]` names, by command name. */
  readonly rejects: ReadonlyMap<string, ReadonlyArray<string>>;
}

const DECLARATION =
  /\b(?:class\s+([A-Za-z_$][\w$]*)\s+extends|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)\s*([A-Za-z_$][\w$.]*)\s*(?:<[^()]*?>)?\s*\(/g;

const kindOfCallee = (callee: string): Kind | undefined => {
  const parts = callee.split(".");
  const last = parts.at(-1)!;
  if (KINDS.has(last)) return last as Kind;
  if (last === "make" && parts.length >= 2 && KINDS.has(parts.at(-2)!)) return parts.at(-2) as Kind;
  if (last === "Service" && parts.at(-2) === "RpcMiddleware") return "Middleware";
  return undefined;
};

export const indexText = (text: string): ModuleIndex => {
  const kinds = new Map<string, Kind>();
  const rejects = new Map<string, ReadonlyArray<string>>();
  const matches = [...text.matchAll(DECLARATION)];
  matches.forEach((match, i) => {
    const name = match[1] ?? match[2]!;
    const kind = kindOfCallee(match[3]!);
    if (kind === undefined) return;
    kinds.set(name, kind);
    if (kind === "Command" || kind === "View" || kind === "Saga") {
      const body = text.slice(match.index!, matches[i + 1]?.index ?? text.length);
      const listed = /\brejects\s*:\s*\[([^\]]*)\]/.exec(body);
      rejects.set(
        name,
        listed
          ? listed[1]!
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry))
          : [],
      );
    }
  });
  return { kinds, rejects };
};

const indexes = new Map<string, Cached<ModuleIndex | undefined>>();

export const moduleIndex = (file: string): ModuleIndex | undefined =>
  cached(indexes, file, () => {
    const text = readText(file);
    return text === undefined ? undefined : indexText(text);
  });

const SKIP_DIRS = new Set(["node_modules", "lib", "dist", "build", "coverage", ".alchemy", ".git"]);
const STORY_FILE = /\.(?:test|spec|story|stories)\.[cm]?tsx?$/;
const STORY_IMPORT = "@alchemy.run/domain/Story";

const listFiles = (dir: string, out: Array<string>): void => {
  let entries: Array<fs.Dirent>;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile() && STORY_FILE.test(entry.name)) out.push(full);
  }
};

const stories = new Map<string, Cached<string>>();

/** The text of every story file of a package (files that import `@alchemy.run/domain/Story`). */
export const storyText = (root: string): string =>
  cached(stories, root, () => {
    const files: Array<string> = [];
    listFiles(root, files);
    return files
      .map(readText)
      .filter((text): text is string => text !== undefined && text.includes(STORY_IMPORT))
      .join("\n");
  });
