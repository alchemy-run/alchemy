/**
 * Fold each binding's `<Op>Http.ts` layer into its `<Op>.ts` contract, so a
 * binding is one file. Layers are pure, so a module holding both still tree
 * shakes to what a Function/Worker provides.
 *
 *   node scripts/codemods/merge-binding-http.ts packages/gcp/src [--dry-run]
 *
 * For every `X.ts` + `XHttp.ts` pair in a service directory it:
 *
 * - merges the two files' imports (a module imported as a type in one and a
 *   value in the other becomes a value import) and drops `XHttp.ts`'s
 *   import of `./X.ts`;
 * - appends `XHttp.ts`'s body to `X.ts` and deletes `XHttp.ts`;
 * - repoints every import or re-export of `XHttp.ts` across the repo at
 *   `X.ts`, dropping re-exports that become duplicates.
 *
 * Shared scaffolding (`BindingHttp.ts`, `AccessHttp.ts`, `BucketHttp.ts`
 * beside the `Bucket` provider: any `*Http.ts` that neither has an
 * `@provides` layer nor exports an `XHttp` built over `./X.ts`) is left
 * alone. A pair whose files declare the same
 * top-level name is reported and skipped.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [srcArg, ...flags] = process.argv.slice(2);
if (srcArg === undefined) {
  console.error("usage: merge-binding-http.ts <package src dir> [--dry-run]");
  process.exit(1);
}
const dryRun = flags.includes("--dry-run");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const src = path.resolve(srcArg);

// ============ Imports ============

interface Named {
  name: string; // `a` or `a as b`
  type: boolean;
}

interface ImportGroup {
  spec: string;
  namespace?: { local: string; type: boolean };
  defaultName?: string;
  named: Named[];
  sideEffect: boolean;
}

const IMPORT = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?\s*$/;
const SIDE_EFFECT = /^import\s+["']([^"']+)["'];?\s*$/;

/** Split a file into its leading import statements and the rest. */
const splitImports = (source: string) => {
  const statements: string[] = [];
  // Line comments above the imports (`// @ts-nocheck`) stay at the top.
  const header = /^(?:\/\/[^\n]*\n)*/.exec(source)![0];
  let rest = source.slice(header.length);
  let leading = "";
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    const skipped = rest.slice(0, rest.length - trimmed.length);
    if (!trimmed.startsWith("import ") && !trimmed.startsWith("import{")) break;
    const end = trimmed.search(/;\s*(\r?\n|$)/);
    if (end < 0) break;
    statements.push(trimmed.slice(0, end + 1));
    rest = trimmed.slice(end + 1);
    leading += skipped;
  }
  return { header, statements, body: rest.replace(/^\s*\n/, "") };
};

const parseImport = (statement: string): ImportGroup | undefined => {
  const flat = statement.replace(/\s+/g, " ").trim();
  const side = SIDE_EFFECT.exec(flat);
  if (side) return { spec: side[1]!, named: [], sideEffect: true };
  const m = IMPORT.exec(flat);
  if (!m) return undefined;
  const typeOnly = m[1] !== undefined;
  const clause = m[2]!.trim();
  const group: ImportGroup = { spec: m[3]!, named: [], sideEffect: false };
  const ns = /\*\s+as\s+(\w+)/.exec(clause);
  if (ns) group.namespace = { local: ns[1]!, type: typeOnly };
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)) {
      const type = typeOnly || part.startsWith("type ");
      group.named.push({ name: part.replace(/^type\s+/, ""), type });
    }
  }
  const def = /^(\w+)\s*(,|$)/.exec(clause);
  if (def && !clause.startsWith("*") && !clause.startsWith("{")) group.defaultName = def[1];
  return group;
};

/** Merge import groups by module, a value import winning over a type import. */
const mergeGroups = (groups: ImportGroup[]) => {
  const bySpec = new Map<string, ImportGroup[]>();
  for (const g of groups) bySpec.set(g.spec, [...(bySpec.get(g.spec) ?? []), g]);
  const lines: string[] = [];
  for (const [spec, gs] of bySpec) {
    const namespaces = new Map<string, boolean>();
    const named = new Map<string, boolean>();
    let defaultName: string | undefined;
    let sideEffect = false;
    for (const g of gs) {
      if (g.namespace) {
        namespaces.set(
          g.namespace.local,
          (namespaces.get(g.namespace.local) ?? true) && g.namespace.type,
        );
      }
      for (const n of g.named) named.set(n.name, (named.get(n.name) ?? true) && n.type);
      defaultName ??= g.defaultName;
      sideEffect ||= g.sideEffect;
    }
    for (const [local, type] of namespaces) {
      lines.push(`import ${type ? "type " : ""}* as ${local} from "${spec}";`);
    }
    if (named.size > 0 || defaultName) {
      const entries = [...named.entries()];
      const allTypes = entries.length > 0 && entries.every(([, t]) => t) && !defaultName;
      const list = entries.map(([n, t]) => (t && !allTypes ? `type ${n}` : n)).join(", ");
      const clause = [defaultName, entries.length ? `{ ${list} }` : undefined]
        .filter(Boolean)
        .join(", ");
      lines.push(`import ${allTypes ? "type " : ""}${clause} from "${spec}";`);
    }
    if (sideEffect && namespaces.size === 0 && named.size === 0 && !defaultName) {
      lines.push(`import "${spec}";`);
    }
  }
  return lines;
};

const topLevelNames = (body: string) =>
  new Set(
    [
      ...body.matchAll(
        /^(?:export\s+)?(?:declare\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+(\w+)/gm,
      ),
    ].map((m) => m[1]!),
  );

// ============ Pairs ============

const services = fs
  .readdirSync(src, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(src, d.name));

const merged: { from: string; to: string }[] = [];
const skipped: string[] = [];

for (const dir of services) {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith("Http.ts"))) {
    const httpPath = path.join(dir, file);
    const http = fs.readFileSync(httpPath, "utf8");
    // The layers' contract module: `X.ts` beside `XHttp.ts`, or else the one
    // sibling the layers import a `Binding.Service` contract from
    // (`ConnectReadHttp.ts` → `Connect.ts`, which declares `ConnectRead`).
    const sameName = path.join(dir, file.replace(/Http\.ts$/, ".ts"));
    const imported = [...http.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"\.\/(\w+)\.ts";/gm)]
      .map((m) => path.join(dir, `${m[1]}.ts`))
      .filter(
        (p) =>
          fs.existsSync(p) &&
          !p.endsWith("Http.ts") &&
          /Binding\.Service</.test(fs.readFileSync(p, "utf8")),
      );
    const contractPath = fs.existsSync(sameName)
      ? sameName
      : new Set(imported).size === 1
        ? imported[0]!
        : undefined;
    if (contractPath === undefined) continue; // shared scaffolding
    const contract = fs.readFileSync(contractPath, "utf8");
    // Only layers implementing the contract move (an `@provides` tag, or an
    // exported `…Http` built over the contract module it imports);
    // scaffolding named after a resource (`BucketHttp.ts` beside the `Bucket`
    // provider) stays.
    const base = path.basename(contractPath);
    const contractName = base.replace(/\.ts$/, "");
    const implementsContract =
      /^export const \w+Http\b/m.test(http) &&
      new RegExp(`^import\\s+(?!type\\b)[^;]*?from\\s+"\\./${contractName}\\.ts";`, "m").test(http);
    if (!/@provides /.test(http) && !implementsContract) continue;

    const c = splitImports(contract);
    const h = splitImports(http);
    const clash = [...topLevelNames(h.body)].filter((n) => topLevelNames(c.body).has(n));
    const groups = [...c.statements, ...h.statements].map(parseImport);
    if (clash.length > 0 || groups.some((g) => g === undefined)) {
      skipped.push(
        `${path.relative(root, httpPath)}: ${clash.length ? `both declare ${clash.join(", ")}` : "an import it can't parse"}`,
      );
      continue;
    }
    const kept = groups.filter((g): g is ImportGroup => g !== undefined && g.spec !== `./${base}`);
    const imports = mergeGroups(kept);
    const header = [...new Set([c.header, h.header])].join("");
    const out = `${header}${imports.join("\n")}\n\n${c.body.trimEnd()}\n\n${h.body.trim()}\n`;
    if (!dryRun) {
      fs.writeFileSync(contractPath, out);
      fs.unlinkSync(httpPath);
    }
    merged.push({ from: httpPath, to: contractPath });
  }
}

// ============ References ============

const tracked = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mts", "*.md", "*.mdx"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("submodules/") && !f.includes("/node_modules/"))
  .map((f) => path.join(root, f))
  .filter((f) => fs.existsSync(f));

const moved = new Map(merged.map(({ from, to }) => [from, to]));
let rewritten = 0;

for (const file of tracked) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes("Http")) continue;
  const dir = path.dirname(file);
  let next = source.replace(
    /(from\s+|import\s*\(\s*|export\s+\*\s+from\s+)(["'])(\.{1,2}\/[^"']+Http)(\.ts)?\2/g,
    (whole, lead: string, quote: string, rel: string, ext: string | undefined) => {
      const target = path.resolve(dir, `${rel}.ts`);
      const to = moved.get(target);
      if (to === undefined) return whole;
      const relTo = path.relative(dir, to).replace(/\\/g, "/");
      const spec = (relTo.startsWith(".") ? relTo : `./${relTo}`).replace(/\.ts$/, ext ?? "");
      return `${lead}${quote}${spec}${quote}`;
    },
  );
  // Package subpaths (`@alchemy.run/gcp/Storage/GetObjectHttp`).
  next = next.replace(
    /(["'])(@alchemy\.run\/[\w-]+\/[\w/]+?)Http\1/g,
    (whole, quote: string, subpath: string) => {
      const [, pkg, rest] = /^@alchemy\.run\/([\w-]+)\/(.+)$/.exec(subpath) ?? [];
      if (pkg === undefined) return whole;
      const target = path.join(root, "packages", pkg, "src", `${rest}Http.ts`);
      return moved.has(target) ? `${quote}${subpath}${quote}` : whole;
    },
  );
  if (next === source) continue;
  // A re-export repointed at a module the file already re-exports is a duplicate.
  const seen = new Set<string>();
  next = next
    .split("\n")
    .filter((line) => {
      const m = /^export \* from (["'][^"']+["']);\s*$/.exec(line);
      if (!m) return true;
      if (seen.has(m[1]!)) return false;
      seen.add(m[1]!);
      return true;
    })
    .join("\n");
  // Two imports of one module (the contract's and the old layer's) become one.
  if (/\.(ts|tsx|mts)$/.test(file)) {
    const { header, statements, body } = splitImports(next);
    const groups = statements.map(parseImport);
    const specs = groups.map((g) => g?.spec);
    if (groups.every((g) => g !== undefined) && new Set(specs).size !== specs.length) {
      next = `${header}${mergeGroups(groups as ImportGroup[]).join("\n")}\n\n${body}`;
    }
  }
  if (!dryRun) fs.writeFileSync(file, next);
  rewritten++;
}

// ============ Cycles ============

// A merged contract now imports its scaffolding (`TableHttp.ts`) as a value;
// scaffolding that imports a value back from that contract (an error class)
// is a cycle that throws at module evaluation. Report it: move the shared
// value into its own module (`TableTypes.ts`) and re-export it.
const cycles: string[] = [];
if (!dryRun) {
  for (const { to } of merged) {
    const dir = path.dirname(to);
    const source = fs.readFileSync(to, "utf8");
    for (const m of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"\.\/(\w+Http)\.ts";/gms)) {
      const scaffold = path.join(dir, `${m[1]}.ts`);
      if (!fs.existsSync(scaffold)) continue;
      const back = new RegExp(
        `^import\\s+(?!type\\b)\\{([^}]*)\\}\\s+from\\s+"\\./${path.basename(to, ".ts")}\\.ts";`,
        "m",
      ).exec(fs.readFileSync(scaffold, "utf8"));
      const values = back?.[1]
        ?.split(",")
        .map((x) => x.trim())
        .filter((x) => x && !x.startsWith("type "));
      if (values?.length) {
        cycles.push(
          `${path.relative(root, scaffold)} imports ${values.join(", ")} from ${path.basename(to)}, which imports it back`,
        );
      }
    }
  }
}

console.log(
  `${dryRun ? "[dry run] " : ""}merged ${merged.length} pairs, rewrote ${rewritten} referencing files`,
);
for (const c of cycles) console.log(`cycle ${c}`);
for (const s of skipped) console.log(`skipped ${s}`);
