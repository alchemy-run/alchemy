/**
 * Logical-id check, for the provider review gate.
 *
 * `Resource()` dies with `DuplicateLogicalIdError` when one logical id is
 * declared as two resource types in a stack, and the type check can't see it.
 * This reads a provider's example programs, hub pages and JSDoc examples and
 * reports ids declared as two types.
 *
 * A code block is one scope, and so is an example project (all of its source
 * files make one stack). Blocks on one page are read separately, except blocks
 * that follow from each other, which a reader combines: a page is also checked
 * as a whole, and a clash that only shows up across blocks is printed as a
 * warning, because a page can legitimately show two unrelated stacks.
 *
 * Usage:
 *   node scripts/check-logical-ids.ts stackit
 */

import * as FS from "node:fs";
import * as Path from "node:path";

const ROOT = Path.resolve(import.meta.dirname, "..");

const provider = process.argv[2]?.toLowerCase();
if (!provider) {
  console.error("Usage: node scripts/check-logical-ids.ts <provider>");
  process.exit(2);
}

/**
 * `Stackit.IaaS.Server("Box", ...)`, a bare `IaaS.Server("Box", ...)`, or the
 * class form `Stackit.Functions.Function<Api>()("Api", ...)`.
 */
const DECLARATION = /\b(?:[A-Z]\w*\.)?([A-Z]\w*\.[A-Z]\w*)(?:<\w+>\(\))?\(\s*["'`]([^"'`$]+)["'`]/g;

/** Namespaces that declare no resources. */
const IGNORED =
  /^(?:Schema|Effect|Layer|Context|Data|Config|Stream|Rpc|RpcGroup|HttpApi\w*|Workflow|Activity|Alchemy|Output)\./;

interface Clash {
  location: string;
  id: string;
  types: string[];
}

const declarations = (source: string): Map<string, Set<string>> => {
  const ids = new Map<string, Set<string>>();
  for (const match of source.matchAll(DECLARATION)) {
    const [, type, id] = match;
    if (IGNORED.test(type!)) continue;
    ids.set(id!, (ids.get(id!) ?? new Set()).add(type!));
  }
  return ids;
};

const clashes = (location: string, source: string): Clash[] =>
  [...declarations(source)]
    .filter(([, types]) => types.size > 1)
    .map(([id, types]) => ({ location, id, types: [...types] }));

const walk = (dir: string, keep: (file: string) => boolean): string[] =>
  FS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const file = Path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(file, keep);
    return keep(file) ? [file] : [];
  });

const relative = (file: string) => Path.relative(ROOT, file);

const stripJsDocMargin = (block: string) => block.replace(/^[ \t]*\* ?/gm, "");

const fenced = (markdown: string): string[] =>
  [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]!);

const errors: Clash[] = [];
const warnings: Clash[] = [];

const examplesDir = Path.join(ROOT, "examples");
for (const name of FS.readdirSync(examplesDir)) {
  if (!name.startsWith(`${provider}-`)) continue;
  const project = Path.join(examplesDir, name);
  const source = walk(project, (file) => /\.tsx?$/.test(file))
    .filter((file) => !relative(file).includes("/test/"))
    .map((file) => FS.readFileSync(file, "utf8"))
    .join("\n");
  errors.push(...clashes(relative(project), source));
}

const hubDir = Path.join(ROOT, "website/src/content/docs", provider);
for (const file of walk(hubDir, (file) => /\.mdx?$/.test(file))) {
  const source = FS.readFileSync(file, "utf8");
  const blocks = fenced(source);
  blocks.forEach((block, index) =>
    errors.push(...clashes(`${relative(file)} block ${index + 1}`, block)),
  );
  const local = new Set(
    errors.filter((clash) => clash.location.startsWith(relative(file))).map((clash) => clash.id),
  );
  warnings.push(
    ...clashes(relative(file), blocks.join("\n")).filter((clash) => !local.has(clash.id)),
  );
}

const sourceDir = Path.join(ROOT, "packages", provider, "src");
for (const file of walk(sourceDir, (file) => file.endsWith(".ts"))) {
  const source = FS.readFileSync(file, "utf8");
  for (const comment of source.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    fenced(stripJsDocMargin(comment[0])).forEach((block) =>
      errors.push(...clashes(relative(file), block)),
    );
  }
}

const print = ({ location, id, types }: Clash) =>
  `  ${location}: "${id}" is declared as ${types.join(" and ")}`;

if (warnings.length > 0) {
  console.log(
    `Across blocks of one page (check they aren't one stack):\n${warnings.map(print).join("\n")}\n`,
  );
}
if (errors.length > 0) {
  console.error(`One logical id declared as two resource types:\n${errors.map(print).join("\n")}`);
  process.exit(1);
}
console.log("No logical id is declared as two resource types.");
