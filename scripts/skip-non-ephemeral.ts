#!/usr/bin/env bun
/**
 * Codemod: gate tests behind `skipIf(SKIP_NON_EPHEMRAL_ACCOUNT_TESTS)` so the
 * temporary-account run can skip tests that can't pass on a fresh, unentitled
 * account.
 *
 *   # gate the specific tests marked with `!!!` in a failures report
 *   bun scripts/skip-non-ephemeral.ts cf-temp-failures.txt
 *
 *   # gate EVERY test in each file listed (one path per line) — e.g. all
 *   # Worker/Queue suites that blow the account's resource caps
 *   bun scripts/skip-non-ephemeral.ts --files worker-queue-files.txt
 */
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { Node, Project } from "ts-morph";

const SKIP_CONST = "SKIP_NON_EPHEMRAL_ACCOUNT_TESTS";
const SKIP_DECL = `const ${SKIP_CONST} = process.env.${SKIP_CONST} === "1";`;

const args = process.argv.slice(2);
const wholeFileMode = args[0] === "--files";
const inputPath = (wholeFileMode ? args[1] : args[0]) ?? "cf-temp-failures.txt";
const pkgDir = nodePath.resolve(import.meta.dir, "../packages/alchemy");

// ---- 1. Build file -> (Set<title> | "*"). "*" means gate every test. ----
const targets = new Map<string, Set<string> | "*">();
if (wholeFileMode) {
  for (const raw of readFileSync(inputPath, "utf8").split("\n")) {
    const f = raw.trim();
    if (f) targets.set(f, "*");
  }
} else {
  let currentFile: string | undefined;
  for (const raw of readFileSync(inputPath, "utf8").split("\n")) {
    const header = raw.match(/^(test\/.*\.test\.ts)\s*$/);
    if (header) {
      currentFile = header[1];
      continue;
    }
    const marked = raw.match(/^\s*-\s*(?:!!!\s*)+(.+?)\s*$/);
    if (marked && currentFile) {
      // Display name is `ancestor > ... > title`; the test() literal is the
      // last segment (describe titles are separate calls).
      const title = marked[1].split(" > ").pop()!.trim();
      const entry = targets.get(currentFile);
      if (entry === "*") continue;
      if (!entry) targets.set(currentFile, new Set([title]));
      else entry.add(title);
    }
  }
}

// ---- 2. Apply the codemod per file ----
const project = new Project({
  tsConfigFilePath: nodePath.join(pkgDir, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});

const literalValue = (node: Node): string | undefined => {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralValue();
  }
  return undefined;
};

let filesModified = 0;
let callsGated = 0;
const unmatched: string[] = [];

for (const [relFile, titles] of targets) {
  const abs = nodePath.join(pkgDir, relFile);
  const sf = project.addSourceFileAtPath(abs);

  // Collect target call expressions first, then mutate.
  const hits: { node: import("ts-morph").CallExpression; title: string }[] = [];
  const seen = new Set<string>();
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!/^(test|it)\b/.test(callee.getText())) return;
    const args = node.getArguments();
    if (args.length === 0) return;
    const name = literalValue(args[0]);
    if (name === undefined) return;
    if (titles !== "*" && !titles.has(name)) return;
    hits.push({ node, title: name });
    seen.add(name);
  });

  if (titles !== "*") {
    for (const title of titles) {
      if (!seen.has(title)) unmatched.push(`${relFile} :: ${title}`);
    }
  }
  if (hits.length === 0) continue;

  const gatedBefore = callsGated;
  for (const { node } of hits) {
    const callee = node.getExpression();
    // Idempotent: already gated on a previous run.
    if (callee.getText().includes(SKIP_CONST)) continue;
    // Merge into an existing `.skipIf(cond)` rather than double-wrapping.
    if (
      Node.isCallExpression(callee) &&
      callee.getExpression().getText().endsWith(".skipIf")
    ) {
      const cond = callee.getArguments()[0];
      if (cond) {
        cond.replaceWithText(`(${cond.getText()}) || ${SKIP_CONST}`);
        callsGated++;
        continue;
      }
    }
    callee.replaceWithText(`${callee.getText()}.skipIf(${SKIP_CONST})`);
    callsGated++;
  }

  if (callsGated === gatedBefore) continue; // nothing new to gate

  // Declare the constant once, after the last import.
  if (!sf.getVariableDeclaration(SKIP_CONST)) {
    const imports = sf.getImportDeclarations();
    const insertIdx =
      imports.length > 0 ? imports[imports.length - 1].getChildIndex() + 1 : 0;
    sf.insertStatements(insertIdx, `\n${SKIP_DECL}`);
  }

  sf.saveSync();
  filesModified++;
}

console.log(`Files modified: ${filesModified}`);
console.log(`Tests gated:    ${callsGated}`);
console.log(`Unmatched:      ${unmatched.length}`);
for (const u of unmatched) console.log(`  ! ${u}`);
