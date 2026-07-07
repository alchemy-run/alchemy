import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Workspaces live OUTSIDE the monorepo on purpose: harnesses walk parent
 * directories for CLAUDE.md / AGENTS.md / .claude settings, and a workspace
 * under the repo root would inherit the alchemy repo's own agent context —
 * contaminating every trial. ~/.cache/alchemy-evals is neutral ground.
 */
export const runsRoot = () =>
  process.env.EVAL_RUNS_DIR ?? join(homedir(), ".cache", "alchemy-evals", "runs");

export interface Workspace {
  readonly runId: string;
  readonly stage: string;
  readonly dir: string;
  readonly workspaceDir: string;
  readonly promptFile: string;
  readonly transcriptPath: string;
  readonly configDir: string;
}

const run = async (cmd: string[], cwd: string, env?: Record<string, string>) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${code}):\n${out}\n${err}`);
  }
  return out;
};

export const newRunId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * Provision an isolated workspace for one trial:
 * copy the task template, render PROMPT.md ({{STAGE}}, {{DOCS}}),
 * `bun install`, and commit a git baseline for later tamper-diffing.
 */
export async function provisionWorkspace(options: {
  taskDir: string;
  runId: string;
  /** Docs URL rendered into the prompt — the docs-iteration axis. */
  docsUrl: string;
  /** Overlay these dirs' contents onto the workspace (oracle mode). */
  overlayDirs?: string[];
}): Promise<Workspace> {
  const { taskDir, runId } = options;
  const stage = `e${runId}`;
  const dir = join(runsRoot(), runId);
  const workspaceDir = join(dir, "workspace");
  const configDir = join(dir, "harness-home");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  cpSync(join(taskDir, "template"), workspaceDir, { recursive: true });
  for (const overlay of options.overlayDirs ?? []) {
    cpSync(overlay, workspaceDir, { recursive: true });
  }

  const promptTemplate = readFileSync(join(taskDir, "PROMPT.md"), "utf8");
  const prompt = promptTemplate
    .replaceAll("{{STAGE}}", stage)
    .replaceAll("{{DOCS}}", options.docsUrl);
  const promptFile = join(workspaceDir, "PROMPT.md");
  writeFileSync(promptFile, prompt);

  await run(["bun", "install"], workspaceDir);
  await run(["git", "init", "-q"], workspaceDir);
  await run(["git", "add", "-A"], workspaceDir);
  await run(
    [
      "git",
      "-c",
      "user.email=evals@alchemy.run",
      "-c",
      "user.name=alchemy-evals",
      "commit",
      "-qm",
      "baseline",
    ],
    workspaceDir,
  );

  return {
    runId,
    stage,
    dir,
    workspaceDir,
    promptFile,
    transcriptPath: join(dir, "transcript.jsonl"),
    configDir,
  };
}

/** Environment handed to the harness AND to grader-side alchemy commands. */
export function trialEnv(workspace: Workspace): Record<string, string> {
  const required = ["ANTHROPIC_API_KEY", "CLOUDFLARE_API_TOKEN"] as const;
  for (const name of required) {
    if (!process.env[name]) {
      throw new Error(
        `${name} missing. Run via doppler:\n  doppler run -p alchemy-v2 -c dev -- bun runner/main.ts ...`,
      );
    }
  }
  const accountId =
    process.env.TEST_CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("TEST_CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID missing");
  }
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? homedir(),
    // Hermetic harness config: no user-level skills / CLAUDE.md / settings.
    CLAUDE_CONFIG_DIR: workspace.configDir,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN!,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    STAGE: workspace.stage,
    // Keep the deployment alive for grading; prompts require agents to gate
    // test teardown on this (the documented afterAll.skipIf convention).
    NO_DESTROY: "1",
    CI: "1",
  };
}
