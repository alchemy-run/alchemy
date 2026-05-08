/**
 * Smoke test suite that exercises `alchemy destroy → deploy → destroy` in each
 * example directory with both `bun` and `pnpm`. Commands run in-place against
 * whatever is currently installed in the workspace; stdio is inherited so
 * output streams directly to the terminal.
 *
 * Modes:
 *   default              → test against the workspace `workspace:*` deps as-is
 *   SMOKE_CANARY=1       → pack + publish alchemy / better-auth / pr-package
 *                          tarballs to pkg.ing under a fresh tag, swap each
 *                          example's `workspace:*` refs for the pkg.ing URLs,
 *                          `bun install`, run, then `git checkout` the example
 *                          package.json files and reinstall on the way out.
 *
 * Env vars:
 *   SMOKE_RUNTIME    `bun` or `pnpm`                        (default: "bun")
 *   SMOKE_CANARY     "1" to enable canary mode              (default: off)
 *   SMOKE_STAGE      stage prefix, e.g. `pr-123` or `main`  (default: "smoke")
 *   PKGING_HOST      pkg.ing host                           (default: pkg.ing)
 *
 * Run with: `bun test ./test/smoke.test.ts`.
 */
import { $ } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TIMEOUT = 10 * 60 * 1000;

const examples = [
  "aws-lambda",
  "aws-lambda-httpapi",
  "aws-lambda-rpc",
  "cloudflare-git-artifacts",
  "cloudflare-neon-drizzle",
  "cloudflare-secrets-store",
  "cloudflare-tanstack",
  "cloudflare-vue",
  // "cloudflare-solidstart",
  // "cloudflare-solidjs-ssr",
  "cloudflare-worker-async",
  "cloudflare-worker",
];
const ALL_RUNTIMES = ["bun", "pnpm"] as const;
type Runtime = (typeof ALL_RUNTIMES)[number];

// `SMOKE_RUNTIME` is the CI escape hatch — the matrix workflow runs one
// job per runtime so each can do its own `<runtime> install` and isolate
// from the other. Unset locally, the test runs both runtimes against
// each example with `bun` going first so it doesn't race `pnpm` on
// shared build outputs (vite `dist/`, `.alchemy/`).
const RUNTIMES: readonly Runtime[] = (() => {
  const filter = process.env.SMOKE_RUNTIME?.trim();
  if (!filter) return ALL_RUNTIMES;
  if (filter !== "bun" && filter !== "pnpm") {
    throw new Error(`SMOKE_RUNTIME must be "bun" or "pnpm" (got: ${filter})`);
  }
  return [filter];
})();

const PUBLISHED = [
  { dir: "alchemy", name: "alchemy" },
  { dir: "better-auth", name: "@alchemy.run/better-auth" },
  { dir: "pr-package", name: "@alchemy.run/pr-package" },
] as const;

const canary = process.env.SMOKE_CANARY === "1";
const host = process.env.PKGING_HOST ?? "pkg.ing";

async function run(cmd: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ALCHEMY_NO_TUI: "1" },
  });
  return await proc.exited;
}

// When the matrix is pinned to a single runtime (CI), use that runtime's
// own `add` command so its install path gets exercised end-to-end —
// otherwise (local: both runtimes) fall back to bun, which writes the
// shared `node_modules` once for both subsequent runs.
const PRIMARY_RUNTIME: Runtime = RUNTIMES[0];
const addCmd = (specs: string[]): string[] =>
  PRIMARY_RUNTIME === "bun"
    ? ["bun", "add", ...specs]
    : ["pnpm", "add", ...specs];

const PNPM_WORKSPACE_PATH = path.join(ROOT, "pnpm-workspace.yaml");

/**
 * pnpm 11 runs an implicit `runDepsStatusCheck` before every `pnpm exec`,
 * which performs a hidden `pnpm install`. Bun's catalog config lives in
 * `package.json#workspaces.catalog` — pnpm doesn't read it. So we mirror
 * the bun catalog (and workspaces list) into a `pnpm-workspace.yaml` for
 * the duration of the suite. Generated, never checked in; cleaned up in
 * `afterAll` and on SIGINT/SIGTERM.
 *
 * Delegates to `scripts/pnpm-workspace.ts` so the file shape (pinned
 * catalog versions resolved from `bun.lock`, build-script allowlist) is
 * identical to what CI's pre-`pnpm install` step writes — otherwise the
 * smoke test would clobber CI's pinned catalogs with loose ranges and
 * trip `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on every per-example install.
 */
const writePnpmWorkspace = async () => {
  const code = await run(
    ["bun", path.join(ROOT, "scripts", "pnpm-workspace.ts")],
    ROOT,
  );
  if (code !== 0) {
    throw new Error(`scripts/pnpm-workspace.ts exited with code ${code}`);
  }
};

const removePnpmWorkspace = async () => {
  const code = await run(
    ["bun", path.join(ROOT, "scripts", "pnpm-workspace.ts"), "--remove"],
    ROOT,
  );
  if (code !== 0) {
    // Best-effort — never fail teardown over a missing file.
    await fs.rm(PNPM_WORKSPACE_PATH, { force: true });
  }
};

if (canary) {
  beforeAll(async () => {
    // CI passes PR_PACKAGE_TOKEN directly via env (matches pr-package.yaml);
    // locally we fall back to `doppler` so contributors don't have to export
    // the secret manually. Either path works.
    let token = process.env.PR_PACKAGE_TOKEN?.trim() ?? "";
    if (!token) {
      try {
        token = (
          await $`doppler secrets get PR_PACKAGE_TOKEN --plain -p alchemy-v2 -c dev`
            .quiet()
            .text()
        ).trim();
      } catch {
        // doppler not installed / not authed — leave token empty, error below
      }
    }
    if (!token) {
      throw new Error(
        "PR_PACKAGE_TOKEN is not set in env and `doppler -p alchemy-v2 -c dev` did not return one. " +
          "Either export PR_PACKAGE_TOKEN, run `bun download:env`, or invoke via `doppler run`.",
      );
    }

    const sha = (await $`git rev-parse HEAD`.quiet().text()).trim().slice(0, 7);
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\..*/, "");
    const tag = `canary-${sha}-${stamp}`;
    const tags = JSON.stringify([tag, "canary"]);
    console.log(`→ canary tag: ${tag} (host=${host})`);

    expect(await run(["bun", "run", "build:packages"], ROOT)).toBe(0);

    for (const { dir, name } of PUBLISHED) {
      const pkgDir = path.join(ROOT, "packages", dir);
      for (const f of await fs.readdir(pkgDir)) {
        if (f.endsWith(".tgz")) await fs.rm(path.join(pkgDir, f));
      }
      expect(
        await run(["bun", "pm", "pack", "--destination", "."], pkgDir),
      ).toBe(0);
      const tgz = (await fs.readdir(pkgDir)).find((f) => f.endsWith(".tgz"));
      if (!tgz) throw new Error(`no tgz produced in ${pkgDir}`);
      const abs = path.join(pkgDir, tgz);
      console.log(`→ publish ${name} (${tgz})`);
      const res = await fetch(`https://${host}/projects/${name}/packages`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tags": tags,
          "X-TTL": "1 hour",
          "Content-Type": "application/gzip",
        },
        body: Bun.file(abs),
      });
      if (!res.ok) {
        throw new Error(
          `publish ${name} failed: ${res.status} ${res.statusText}\n${await res.text()}`,
        );
      }
    }

    // `<runtime> add` mutates the root lockfile + install cache — running
    // them in parallel across examples races on both. Keep sequential.
    for (const example of examples) {
      const exampleDir = path.join(ROOT, "examples", example);
      const pkg = JSON.parse(
        await fs.readFile(path.join(exampleDir, "package.json"), "utf8"),
      );
      const adds: string[] = [];
      for (const k of ["dependencies", "devDependencies"] as const) {
        const deps = pkg[k];
        if (!deps) continue;
        for (const [n, v] of Object.entries(deps)) {
          if (v === "workspace:*" && PUBLISHED.some((p) => p.name === n)) {
            adds.push(`${n}@https://${host}/${n}/${tag}`);
          }
        }
      }
      if (adds.length > 0) {
        expect(await run(addCmd(adds), exampleDir)).toBe(0);
      }
    }
  }, TIMEOUT);
}

/**
 * Restore every example's published-package deps (alchemy / better-auth /
 * pr-package) back to `workspace:*`. Idempotent — only emits an `add`
 * command when something is actually pointing at a non-workspace source,
 * so this is a no-op for the non-canary path that never mutates anything
 * in the first place.
 */
const restoreWorkspaceDeps = async () => {
  // Sequential — concurrent add calls race on the root lockfile.
  for (const example of examples) {
    const exampleDir = path.join(ROOT, "examples", example);
    let pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(
        await fs.readFile(path.join(exampleDir, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const adds: string[] = [];
    for (const k of ["dependencies", "devDependencies"] as const) {
      const deps = pkg[k];
      if (!deps) continue;
      for (const [n, v] of Object.entries(deps)) {
        if (PUBLISHED.some((p) => p.name === n) && v !== "workspace:*") {
          adds.push(`${n}@workspace:*`);
        }
      }
    }
    if (adds.length > 0) {
      console.log(`→ restoring ${example}: ${adds.join(" ")}`);
      await run(["bun", "add", ...adds], exampleDir);
    }
  }
};

// Always-on setup: write `pnpm-workspace.yaml` mirroring bun's catalog so
// `pnpm exec` works in CI (pnpm 11's deps-status check otherwise fails on
// `catalog:` deps it doesn't know about).
beforeAll(writePnpmWorkspace, TIMEOUT);

// Always restore + clean up on a normal end-of-suite, regardless of canary
// mode.
afterAll(async () => {
  await restoreWorkspaceDeps();
  await removePnpmWorkspace();
}, TIMEOUT);

// Also restore + clean up if the suite is interrupted (Ctrl+C / SIGTERM).
let restoring = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (restoring) return;
    restoring = true;
    Promise.allSettled([restoreWorkspaceDeps(), removePnpmWorkspace()])
      .catch((err) => console.error("teardown failed:", err))
      .finally(() => process.exit(130));
  });
}

// One `test.concurrent` per (example, runtime) so failures point at the
// specific runtime that broke. Examples run in parallel, but within a
// single example the runtimes are chained on a per-example promise so bun
// finishes its destroy → deploy → destroy before pnpm starts in the same
// directory (otherwise both runs race on shared build outputs like
// vite's `dist/` and `.alchemy/`).
for (const example of examples) {
  const cwd = path.join(ROOT, "examples", example);
  let prev: Promise<unknown> = Promise.resolve();
  for (const runtime of RUNTIMES) {
    // Prefix the stage with $SMOKE_STAGE when provided so PR runs
    // (`pr-<n>-…`) and main runs (`main-…`) never collide on the same
    // cloud resource. Locally falls back to a fixed `smoke` prefix.
    const stagePrefix = (process.env.SMOKE_STAGE ?? "smoke")
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const stage = `${stagePrefix}-${runtime}-${example}`
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const cmd = (action: "destroy" | "deploy") =>
      runtime === "bun"
        ? ["bun", "alchemy", action, "--stage", stage, "--yes"]
        : ["pnpm", "exec", "alchemy", action, "--stage", stage, "--yes"];

    const myPrev = prev;
    let release!: () => void;
    prev = new Promise<void>((r) => {
      release = r;
    });

    test.concurrent(
      `${example} (${runtime}): destroy → deploy → destroy`,
      async () => {
        // Wait for the previous runtime in this example to release the
        // shared working directory. `catch(() => {})` so a failed earlier
        // runtime doesn't cascade-fail every later runtime — the failure
        // is already attributed to the right test.
        await myPrev.catch(() => {});
        try {
          expect(await run(cmd("destroy"), cwd)).toBe(0);
          expect(await run(cmd("deploy"), cwd)).toBe(0);
          expect(await run(cmd("destroy"), cwd)).toBe(0);
        } finally {
          release();
        }
      },
      TIMEOUT,
    );
  }
}
