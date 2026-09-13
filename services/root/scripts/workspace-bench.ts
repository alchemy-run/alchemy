/**
 * Benchmark the workspace lifecycle (`sandbox/WorkspaceHost.ts`) on
 * THIS repository: how long a workspace takes to provision, how much
 * disk it REALLY consumes (APFS clones share blocks, so `du` lies —
 * the volume's free-space delta is the truth), and what a session's
 * first `pnpm install` costs on top. Runs the verbs in-process (the
 * same code the dev sandbox server serves). From the repo root:
 *
 *   bun services/alchemy-org/scripts/workspace-bench.ts [--install]
 *
 * `--install` adds the `pnpm install --frozen-lockfile` step (~20s,
 * dominated by the root prepare script). The workspace is dropped at
 * the end and the benchmark waits for the trash reaper, so the repo is
 * left clean.
 */
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  makeWorkspaceHost,
  WORKSPACES_DIR,
  workspaceDir,
} from "../src/sandbox/WorkspaceHost.ts";

const KEY = "bench::ws-bench";
const withInstall = process.argv.includes("--install");

const sh = async (command: string[], cwd?: string): Promise<string> => {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${code}: ${await new Response(proc.stderr).text()}`,
    );
  }
  return out.trim();
};

const root = await sh(["git", "rev-parse", "--show-toplevel"]);
const workspacesDir = resolve(root, WORKSPACES_DIR);
const treeDir = resolve(workspacesDir, workspaceDir(KEY));

const freeKb = async () =>
  Number((await sh(["df", "-k", root])).split("\n")[1]!.split(/\s+/)[3]);
const mb = (kb: number) => `${(kb / 1024).toFixed(0)} MB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const host = await Effect.runPromise(
  makeWorkspaceHost(root).pipe(Effect.provide(BunServices.layer)),
);
const run = <A>(effect: Effect.Effect<A, string>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

const timed = async (work: Promise<unknown>) => {
  const t0 = performance.now();
  await work;
  return performance.now() - t0;
};

const rows: Array<[string, string, string]> = [];

// a stale workspace from an interrupted run would time as an adopt
await run(host.workspaceDrop(KEY));

const free0 = await freeKb();
const ensureMs = await timed(run(host.workspaceEnsure(KEY)));
const free1 = await freeKb();
const apparent = (await sh(["du", "-sk", treeDir])).split(/\s+/)[0];
rows.push([
  "ensure (worktree + distilled + node_modules seed)",
  secs(ensureMs),
  `${mb(free0 - free1)} real of ${mb(Number(apparent))} apparent`,
]);

if (withInstall) {
  const free2 = await freeKb();
  const installMs = await timed(
    sh(["pnpm", "install", "--frozen-lockfile"], treeDir),
  );
  rows.push([
    "pnpm install --frozen-lockfile (in the workspace)",
    secs(installMs),
    mb(free2 - (await freeKb())),
  ]);
}

const adoptMs = await timed(run(host.workspaceEnsure(KEY)));
rows.push(["ensure again (adopt by key)", secs(adoptMs), "0 MB"]);

const dropMs = await timed(run(host.workspaceDrop(KEY)));
const reapT0 = performance.now();
while (
  readdirSync(workspacesDir).some((entry) => entry.startsWith(".trash-"))
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
