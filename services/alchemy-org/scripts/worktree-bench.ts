/**
 * Benchmark the session-worktree lifecycle (`worktree.ts`) on THIS
 * repository: how long a tree takes to provision, how much disk it
 * REALLY consumes (APFS clones share blocks, so `du` lies — the
 * volume's free-space delta is the truth), and what the session's
 * first `pnpm install` costs on top. Run from the repo root:
 *
 *   bun services/alchemy-org/scripts/worktree-bench.ts [--install]
 *
 * `--install` adds the `pnpm install --frozen-lockfile` step (~20s,
 * dominated by the root prepare script). The tree is dropped at the
 * end and the benchmark waits for the trash reaper, so the repo is
 * left clean.
 */
import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const KEY = "bench-worktree";
const SCRIPT = "services/alchemy-org/scripts/worktree.ts";
const withInstall = process.argv.includes("--install");

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const treeDir = resolve(root, ".alchemy/worktrees", KEY);
const trashDir = resolve(root, ".alchemy/worktrees");

const freeKb = async () =>
  Number((await $`df -k ${root}`.text()).split("\n")[1]!.split(/\s+/)[3]);

const mb = (kb: number) => `${(kb / 1024).toFixed(0)} MB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const timed = async (work: Promise<unknown>) => {
  const t0 = performance.now();
  await work;
  return performance.now() - t0;
};

const rows: Array<[string, string, string]> = [];

// a stale tree from an interrupted run would time as an adopt, not a build
await $`bun ${SCRIPT} drop ${KEY}`.cwd(root).quiet();

const free0 = await freeKb();
const ensureMs = await timed($`bun ${SCRIPT} ensure ${KEY}`.cwd(root).quiet());
const free1 = await freeKb();
const apparent = (await $`du -sk ${treeDir}`.text()).split(/\s+/)[0];
rows.push([
  "ensure (worktree + distilled + node_modules seed)",
  secs(ensureMs),
  `${mb(free0 - free1)} real of ${mb(Number(apparent))} apparent`,
]);

if (withInstall) {
  const free2 = await freeKb();
  const installMs = await timed(
    $`pnpm install --frozen-lockfile`.cwd(treeDir).quiet(),
  );
  rows.push([
    "pnpm install --frozen-lockfile (in the tree)",
    secs(installMs),
    mb(free2 - (await freeKb())),
  ]);
}

const adoptMs = await timed($`bun ${SCRIPT} ensure ${KEY}`.cwd(root).quiet());
rows.push(["ensure again (adopt by key)", secs(adoptMs), "0 MB"]);

const dropMs = await timed($`bun ${SCRIPT} drop ${KEY}`.cwd(root).quiet());
const reapT0 = performance.now();
while (
  readdirSync(trashDir).some((entry) => entry.startsWith(`.trash-${KEY}-`))
) {
  if (performance.now() - reapT0 > 300_000) {
    throw new Error("trash reaper did not finish within 5 minutes");
  }
  await Bun.sleep(250);
}
rows.push([
  "drop (rename) + detached reap (to files gone)",
  `${secs(dropMs)} + ${secs(performance.now() - reapT0)}`,
  mb((await freeKb()) - free0) + " returned (net)",
]);

if (existsSync(treeDir)) throw new Error(`tree survived the drop: ${treeDir}`);

const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, time, disk] of rows) {
  console.log(`${label.padEnd(width)}  ${time.padStart(8)}  ${disk}`);
}
