import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CheckResult,
  LayerResults,
  TaskManifest,
  VerifyContext,
} from "./types.ts";
import type { Workspace } from "./workspace.ts";

interface Exec {
  code: number | null;
  out: string;
  ms: number;
}

const exec = async (
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Exec> => {
  const started = Date.now();
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: out + err, ms: Date.now() - started };
};

/** Find `__stack_output__.json` under .alchemy/state/<stack>/<stage>/. */
function readStackOutputs(
  workspaceDir: string,
  stage: string,
): Record<string, unknown> | undefined {
  const stateDir = join(workspaceDir, ".alchemy", "state");
  if (!existsSync(stateDir)) return undefined;
  for (const stack of readdirSync(stateDir)) {
    const file = join(stateDir, stack, stage, "__stack_output__.json");
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      // state encoding may wrap the payload; unwrap common shapes
      return (parsed?.outputs ?? parsed?.value ?? parsed) as Record<
        string,
        unknown
      >;
    }
  }
  return undefined;
}

async function healthProbe(url: string, path: string): Promise<CheckResult> {
  let lastError = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${url}${path}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { id: "health", pass: true };
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await Bun.sleep(Math.min(500 * 2 ** attempt, 8_000));
  }
  return { id: "health", pass: false, detail: lastError };
}

/**
 * The gated verification pyramid (v1 subset): L0 tsc → L1 grader re-deploy +
 * outputs → L2 health → L3 hidden checks → L5a agent tests → destroy.
 * Layers gate upward; earned results are banked.
 */
export async function verify(options: {
  taskDir: string;
  task: TaskManifest;
  workspace: Workspace;
  env: Record<string, string>;
}): Promise<{ layers: LayerResults; url?: string }> {
  const { taskDir, task, workspace, env } = options;
  const cwd = workspace.workspaceDir;
  const layers: LayerResults = {
    l0Static: { pass: false },
    l1Deploy: { pass: false, outputsPresent: false },
    l2Health: { pass: false },
    l3Functional: { ran: false, passed: 0, total: 0, checks: [] },
    l5AgentTests: { present: false, usesHarness: false, passed: false },
    destroy: { attempted: false, clean: false },
  };

  // L0 — tsc
  const tsc = await exec(
    [join(cwd, "node_modules", ".bin", "tsc"), "-p", "."],
    cwd,
    env,
    180_000,
  );
  layers.l0Static = {
    pass: tsc.code === 0,
    detail: tsc.code === 0 ? undefined : tsc.out.slice(0, 2000),
  };

  // L1 — grader-side re-deploy (idempotent converge) + stack outputs
  const deploy = await exec(
    ["bun", "alchemy", "deploy", "--stage", workspace.stage, "--yes"],
    cwd,
    env,
    420_000,
  );
  const outputs = readStackOutputs(cwd, workspace.stage) ?? {};
  const outputsPresent = task.requiredOutputs.every(
    (name) => typeof outputs[name] === "string" && outputs[name] !== "",
  );
  layers.l1Deploy = {
    pass: deploy.code === 0,
    deployMs: deploy.ms,
    outputsPresent,
    detail: deploy.code === 0 ? undefined : deploy.out.slice(-2000),
  };
  const url =
    typeof outputs.url === "string" ? outputs.url.replace(/\/$/, "") : undefined;

  // L2 — health (only if deploy converged and outputs exist). Spec tasks
  // promise /health; user-voice tasks only promise a product at `/`.
  if (layers.l1Deploy.pass && outputsPresent && url) {
    const health = await healthProbe(url, task.mode === "user" ? "/" : "/health");
    layers.l2Health = { pass: health.pass, detail: health.detail };
  }

  // L3 — hidden functional verification. "spec" tasks run deterministic
  // verify/checks.ts; "user" tasks run the black-box verifier agent against
  // verify/intent.md (no pinned contract to check mechanically).
  if (layers.l2Health.pass && url) {
    const context: VerifyContext = { url, outputs };
    try {
      let checks: CheckResult[];
      if (task.mode === "user") {
        const { runVerifierAgent } = await import("./verify-agent.ts");
        checks = await runVerifierAgent({ taskDir, context });
      } else {
        const checksModule = await import(join(taskDir, "verify", "checks.ts"));
        checks = await checksModule.run(context);
      }
      layers.l3Functional = {
        ran: true,
        passed: checks.filter((c) => c.pass).length,
        total: checks.length,
        checks,
      };
    } catch (error) {
      layers.l3Functional = {
        ran: true,
        passed: 0,
        total: 1,
        checks: [{ id: "suite", pass: false, detail: String(error) }],
      };
    }
  }

  // L5a — agent-authored tests (exist beyond smoke, use the harness, pass)
  const testDir = join(cwd, "test");
  const testFiles = existsSync(testDir)
    ? readdirSync(testDir).filter(
        (f) => f.endsWith(".test.ts") && f !== "smoke.test.ts",
      )
    : [];
  const usesHarness = testFiles.some((f) => {
    const source = readFileSync(join(testDir, f), "utf8");
    return source.includes("Test.make") && source.includes("beforeAll");
  });
  if (layers.l2Health.pass) {
    const vitest = await exec(
      ["bun", "vitest", "run", "--reporter=dot"],
      cwd,
      { ...env, NO_DESTROY: "1" },
      420_000,
    );
    layers.l5AgentTests = {
      present: testFiles.length > 0,
      usesHarness,
      passed: vitest.code === 0,
      detail: vitest.code === 0 ? undefined : vitest.out.slice(-2000),
    };
  } else {
    layers.l5AgentTests.present = testFiles.length > 0;
    layers.l5AgentTests.usesHarness = usesHarness;
  }

  // Destroy — always attempted, scored but never gating.
  const destroy = await exec(
    ["bun", "alchemy", "destroy", "--stage", workspace.stage, "--yes"],
    cwd,
    env,
    420_000,
  );
  layers.destroy = {
    attempted: true,
    clean: destroy.code === 0,
    detail: destroy.code === 0 ? undefined : destroy.out.slice(-2000),
  };

  return { layers, url };
}

/** Weighted 0–100 score + headline binary, per the plan's 7-line pyramid. */
export function score(
  layers: LayerResults,
  task: TaskManifest,
): { score: number; e2ePass: boolean } {
  let total = 0;
  if (layers.l0Static.pass) total += 5;
  if (layers.l1Deploy.pass && layers.l1Deploy.outputsPresent) total += 10;
  if (layers.l2Health.pass) total += 10;
  if (layers.l3Functional.total > 0) {
    total += Math.round(
      35 * (layers.l3Functional.passed / layers.l3Functional.total),
    );
  }
  if (
    layers.l5AgentTests.present &&
    layers.l5AgentTests.usesHarness &&
    layers.l5AgentTests.passed
  ) {
    total += 5;
  }
  if (layers.destroy.clean) total += 10;

  const mustPass = new Set(task.mustPassChecks);
  const mustPassOk =
    layers.l3Functional.ran &&
    layers.l3Functional.checks
      .filter((c) => mustPass.has(c.id))
      .every((c) => c.pass) &&
    layers.l3Functional.checks.filter((c) => mustPass.has(c.id)).length ===
      mustPass.size;

  return {
    score: total,
    e2ePass:
      layers.l1Deploy.pass &&
      layers.l2Health.pass &&
      mustPassOk &&
      layers.destroy.clean,
  };
}
