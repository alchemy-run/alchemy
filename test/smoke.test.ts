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
 *   SMOKE_RUNTIMES   comma-separated subset of: bun, pnpm   (default: both)
 *   SMOKE_EXAMPLES   comma-separated example dir names      (default: 4 default)
 *   SMOKE_CANARY     "1" to enable canary mode              (default: off)
 *   PKGING_HOST      pkg.ing host                           (default: pkg.ing)
 *
 * Run with: `bun test ./test/smoke.test.ts`.
 */
import { $ } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TIMEOUT = 10 * 60 * 1000;

const DEFAULT_EXAMPLES = [
  "aws-lambda",
  "cloudflare-git-artifacts",
  "cloudflare-neon-drizzle",
  "cloudflare-secrets-store",
  "cloudflare-tanstack",
  "cloudflare-worker-async",
  "cloudflare-worker",
];
const DEFAULT_RUNTIMES = ["bun", "pnpm"] as const;
type Runtime = (typeof DEFAULT_RUNTIMES)[number];

const PUBLISHED = [
  { dir: "alchemy", name: "alchemy" },
  { dir: "better-auth", name: "@alchemy.run/better-auth" },
  { dir: "pr-package", name: "@alchemy.run/pr-package" },
] as const;

const examples =
  process.env.SMOKE_EXAMPLES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? DEFAULT_EXAMPLES;

const runtimes = (process.env.SMOKE_RUNTIMES?.split(",")
  .map((s) => s.trim())
  .filter(Boolean) ?? [...DEFAULT_RUNTIMES]) as Runtime[];

for (const r of runtimes) {
  if (r !== "bun" && r !== "pnpm") {
    throw new Error(`SMOKE_RUNTIMES contains unknown runtime: ${r}`);
  }
}

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

if (canary) {
  beforeAll(async () => {
    const token = (
      await $`doppler secrets get PR_PACKAGE_TOKEN --plain -p alchemy-v2 -c dev`
        .quiet()
        .text()
    ).trim();
    if (!token) {
      throw new Error(
        "PR_PACKAGE_TOKEN is empty (doppler -p alchemy-v2 -c dev returned nothing)",
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
      expect(
        await run(
          [
            "curl",
            "-fsSL",
            "--show-error",
            "-X",
            "PUT",
            `https://${host}/projects/${name}/packages`,
            "-H",
            `Authorization: Bearer ${token}`,
            "-H",
            `X-Tags: ${tags}`,
            "-H",
            "X-TTL: 1 week",
            "-H",
            "Content-Type: application/gzip",
            "--data-binary",
            `@${abs}`,
          ],
          ROOT,
        ),
      ).toBe(0);
    }

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
        expect(await run(["bun", "add", ...adds], exampleDir)).toBe(0);
      }
    }
  }, TIMEOUT);

  afterAll(async () => {
    for (const example of examples) {
      const exampleDir = path.join(ROOT, "examples", example);
      const pkg = JSON.parse(
        await fs.readFile(path.join(exampleDir, "package.json"), "utf8"),
      );
      const adds: string[] = [];
      for (const k of ["dependencies", "devDependencies"] as const) {
        const deps = pkg[k];
        if (!deps) continue;
        for (const n of Object.keys(deps)) {
          if (PUBLISHED.some((p) => p.name === n)) {
            adds.push(`${n}@workspace:*`);
          }
        }
      }
      if (adds.length > 0) {
        await run(["bun", "add", ...adds], exampleDir);
      }
    }
  }, TIMEOUT);
}

describe.concurrent("examples", () => {
  for (const example of examples) {
    describe(`${example}`, () => {
      for (const runtime of runtimes) {
        const cwd = path.join(ROOT, "examples", example);
        const stage = `smoke-${runtime}-${example}`
          .replace(/[^a-zA-Z0-9-]/g, "-")
          .toLowerCase();
        const cmd = (action: "destroy" | "deploy") =>
          runtime === "bun"
            ? ["bun", "alchemy", action, "--stage", stage, "--yes"]
            : ["pnpm", "exec", "alchemy", action, "--stage", stage, "--yes"];

        test(
          `${example} (${runtime}): destroy → deploy → destroy`,
          async () => {
            expect(await run(cmd("destroy"), cwd)).toBe(0);
            expect(await run(cmd("deploy"), cwd)).toBe(0);
            expect(await run(cmd("destroy"), cwd)).toBe(0);
          },
          TIMEOUT,
        );
      }
    });
  }
});
