import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "./adapters/index.ts";
import { appendEvent, appendRun } from "./journal.ts";
import type {
  Budgets,
  HarnessName,
  TaskManifest,
  TrialRecord,
} from "./types.ts";
import { verify, score } from "./verify.ts";
import { newRunId, provisionWorkspace, trialEnv } from "./workspace.ts";

export interface CellSpec {
  readonly taskDir: string;
  readonly harness: HarnessName | "oracle";
  readonly model: string;
  readonly budgets: Budgets;
  /** Docs URL handed to the agent (prod or a deployed website preview). */
  readonly docsUrl: string;
}

export async function runCell(spec: CellSpec): Promise<TrialRecord> {
  const task: TaskManifest = JSON.parse(
    readFileSync(join(spec.taskDir, "task.json"), "utf8"),
  );
  const budgets: Budgets = { ...spec.budgets, ...task.budgets };
  const runId = newRunId();
  const startedAt = new Date().toISOString();

  appendEvent({ event: "provisioning", runId, task: task.id, harness: spec.harness });
  const workspace = await provisionWorkspace({
    taskDir: spec.taskDir,
    runId,
    docsUrl: spec.docsUrl,
    overlayDirs:
      spec.harness === "oracle" ? [join(spec.taskDir, "answer")] : undefined,
  });
  const env = trialEnv(workspace);

  let agent: {
    terminationReason: TrialRecord["terminationReason"];
    turns?: number;
    tokensIn: number;
    tokensCachedIn: number;
    tokensOut: number;
    agentCostUsd?: number;
    agentWallClockMs: number;
    harnessVersion: string;
  };

  if (spec.harness === "oracle") {
    // Oracle mode: the reference solution was overlaid; deploy it directly
    // so the verify pipeline exercises exactly what an agent run produces.
    appendEvent({ event: "oracle_deploy", runId });
    const started = Date.now();
    const proc = Bun.spawn(
      ["bun", "alchemy", "deploy", "--stage", workspace.stage, "--yes"],
      { cwd: workspace.workspaceDir, env, stdout: "pipe", stderr: "pipe" },
    );
    const out =
      (await new Response(proc.stdout).text()) +
      (await new Response(proc.stderr).text());
    const code = await proc.exited;
    if (code !== 0) {
      appendEvent({ event: "oracle_deploy_failed", runId, out: out.slice(-3000) });
    }
    agent = {
      terminationReason: "oracle",
      tokensIn: 0,
      tokensCachedIn: 0,
      tokensOut: 0,
      agentWallClockMs: Date.now() - started,
      harnessVersion: "oracle",
    };
  } else {
    const adapter = adapters[spec.harness];
    const harnessVersion = await adapter.version();
    appendEvent({ event: "agent_running", runId, harness: spec.harness, model: spec.model, harnessVersion });
    const result = await adapter.run({
      promptFile: workspace.promptFile,
      cwd: workspace.workspaceDir,
      model: spec.model,
      env,
      timeoutMs: budgets.wallClockMs,
      maxTurns: budgets.maxTurns,
      budgetUsd: budgets.budgetUsd,
      transcriptPath: workspace.transcriptPath,
    });
    appendEvent({
      event: "agent_done",
      runId,
      terminationReason: result.terminationReason,
      turns: result.turns,
      costUsd: result.costUsd,
      wallClockMs: result.wallClockMs,
    });
    agent = {
      terminationReason: result.terminationReason,
      turns: result.turns,
      tokensIn: result.usage.input,
      tokensCachedIn: result.usage.cachedInput,
      tokensOut: result.usage.output,
      agentCostUsd: result.costUsd,
      agentWallClockMs: result.wallClockMs,
      harnessVersion,
    };
  }

  appendEvent({ event: "verifying", runId });
  const { layers } = await verify({
    taskDir: spec.taskDir,
    task,
    workspace,
    env,
  });
  const scored = score(layers, task);

  const record: TrialRecord = {
    runId,
    taskId: task.id,
    taskVersion: task.version,
    family: task.family,
    harness: spec.harness,
    harnessVersion: agent.harnessVersion,
    model: spec.model,
    condition: "C1_docs",
    docsUrl: spec.docsUrl,
    stage: workspace.stage,
    startedAt,
    terminationReason: agent.terminationReason,
    turns: agent.turns,
    tokensIn: agent.tokensIn,
    tokensCachedIn: agent.tokensCachedIn,
    tokensOut: agent.tokensOut,
    agentCostUsd: agent.agentCostUsd,
    agentWallClockMs: agent.agentWallClockMs,
    layers,
    score: scored.score,
    e2ePass: scored.e2ePass,
    workspacePath: workspace.workspaceDir,
    transcriptPath:
      spec.harness === "oracle" ? undefined : workspace.transcriptPath,
  };
  appendRun(record);
  appendEvent({ event: "done", runId, score: record.score, e2ePass: record.e2ePass });
  return record;
}
