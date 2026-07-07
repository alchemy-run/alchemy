// The "TypeScript (Native Preview)" extension resolves the workspace tsgo binary
// by looking for a hoisted platform package at
//   node_modules/@typescript/native-preview-<platform>-<arch>/lib/tsgo
// (see the extension's `resolveTsdkPathToExe`, which mirrors
//  @typescript/native-preview/lib/getExePath.js).
//
// bun does NOT hoist that optional platform package to the sibling path — it
// lives under node_modules/.bun/… and only `@typescript/native-preview` itself
// is symlinked. Without the sibling, the extension can't find the workspace
// binary: "Use Workspace Version" never appears and it silently falls back to
// its own UNPATCHED bundled tsgo (no Effect diagnostics).
//
// This script materializes the missing sibling symlink so the extension's
// resolver works. It is idempotent and safe to run on every install.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const platformPackage = `native-preview-${process.platform}-${process.arch}`;
const scopedName = `@typescript/${platformPackage}`;

let platformPackageRoot;
try {
  platformPackageRoot = path.dirname(
    require.resolve(`${scopedName}/package.json`),
  );
} catch {
  // Platform unsupported or the package isn't installed — nothing to link.
  console.log(
    `[link-native-preview-tsgo] ${scopedName} not resolvable; skipping.`,
  );
  process.exit(0);
}

const typescriptScopeDir = path.resolve(process.cwd(), "node_modules", "@typescript");
const linkPath = path.join(typescriptScopeDir, platformPackage);

// Relative target keeps the symlink valid regardless of where the repo lives.
const target = path.relative(typescriptScopeDir, platformPackageRoot);

try {
  const existing = fs.readlinkSync(linkPath);
  if (existing === target) {
    console.log(`[link-native-preview-tsgo] ${platformPackage} already linked.`);
    process.exit(0);
  }
  fs.rmSync(linkPath, { recursive: true, force: true });
} catch {
  // No existing link/dir — fine.
}

fs.mkdirSync(typescriptScopeDir, { recursive: true });
fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
console.log(`[link-native-preview-tsgo] linked ${platformPackage} -> ${target}`);
