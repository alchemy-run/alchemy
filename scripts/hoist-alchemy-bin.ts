/**
 * Hoists the platform-appropriate `alchemy` launcher into every
 * `node_modules/.bin/` in the workspace, so `bun run deploy` / `alchemy ...`
 * works from any workspace member during dev.
 *
 * Why this exists: bun workspaces do not hoist bins from a workspace
 * package's `optionalDependencies` (e.g. `@alchemy.run/cli-posix`,
 * `@alchemy.run/cli-win32`) up to consumers of that package. Consumers end up
 * with either no `alchemy` bin, or a stale shim from a previous install
 * pointing at the long-removed `packages/alchemy/bin/alchemy.sh` — which is
 * what produces the `interpreter executable "/bin/sh" not found` error on
 * Windows.
 *
 * Published installs are unaffected: npm/bun flatten optional deps at
 * install time and hoist their bins normally. This script runs only on
 * `bun install` inside the monorepo because it's registered as the root
 * `package.json`'s postinstall, and that root is `"private": true` — it is
 * never installed as a dependency by anyone.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const isWin = process.platform === "win32";

const posixLauncher = resolve(repoRoot, "packages", "cli-posix", "alchemy");
const win32Launcher = resolve(repoRoot, "packages", "cli-win32", "alchemy.cmd");
const target = isWin ? win32Launcher : posixLauncher;

if (!existsSync(target)) {
  console.warn(`[hoist-alchemy-bin] launcher not found at ${target}; skipping`);
  process.exit(0);
}

// Stale shims that previous installs may have left behind. When alchemy's
// own bin pointed at `bin/alchemy.sh`, bun generated `.bunx` / `.exe`
// wrappers that hardcoded `/bin/sh` as the interpreter. If we don't clear
// them, they win the PATH lookup before our replacement and produce the
// "interpreter executable /bin/sh not found" error on Windows.
const staleNames = [
  "alchemy",
  "alchemy.cmd",
  "alchemy.bunx",
  "alchemy.exe",
  "alchemy.ps1",
];

function writeShim(binDir: string) {
  mkdirSync(binDir, { recursive: true });
  for (const name of staleNames) {
    const p = join(binDir, name);
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true });
      } catch {
        // Best-effort cleanup; keep going.
      }
    }
  }

  if (isWin) {
    const shimPath = join(binDir, "alchemy.cmd");
    // `%~dp0` is the directory containing the cmd file; delegate to the
    // packaged launcher via an absolute path resolved here at write time.
    const content = `@echo off\r\n"${target}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    writeFileSync(shimPath, content);
  } else {
    const shimPath = join(binDir, "alchemy");
    const rel = relative(binDir, target);
    symlinkSync(rel, shimPath);
  }
}

/**
 * Find every workspace member's node_modules/.bin directory (plus the root
 * node_modules/.bin). `bun run` walks PATH from the cwd up through ancestor
 * node_modules/.bin dirs, so in principle we only need the root. In practice
 * leftover stale shims in per-workspace .bin dirs can still win the lookup,
 * so we install the real shim in each.
 */
function workspaceDirs(): string[] {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf-8"),
  );
  const globs: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);

  const dirs = new Set<string>([repoRoot]);
  for (const pattern of globs) {
    // Support only the `parent/*` form actually used in this repo.
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      const parentPath = join(repoRoot, parent);
      if (!existsSync(parentPath)) continue;
      for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(parentPath, entry.name);
        if (existsSync(join(candidate, "package.json"))) {
          dirs.add(candidate);
        }
      }
    } else {
      const candidate = join(repoRoot, pattern);
      if (existsSync(join(candidate, "package.json"))) {
        dirs.add(candidate);
      }
    }
  }
  return [...dirs];
}

let touched = 0;
for (const dir of workspaceDirs()) {
  const binDir = join(dir, "node_modules", ".bin");
  // Only install in workspaces that have been bun-installed (have a
  // node_modules). Skip ones that haven't — they don't need the shim.
  if (!existsSync(dirname(binDir))) continue;
  try {
    writeShim(binDir);
    touched++;
  } catch (err) {
    // Non-fatal: don't let a write failure in one workspace block install.
    console.warn(
      `[hoist-alchemy-bin] failed to write shim in ${binDir}: ${err}`,
    );
  }
}

console.log(
  `[hoist-alchemy-bin] installed alchemy shim in ${touched} .bin dir(s)`,
);
