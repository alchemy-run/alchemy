/**
 * Shared types for the eval runner. Plain TypeScript run with bun — the
 * runner is orchestration tooling, not alchemy resource code, so the
 * Effect-platform rules from AGENTS.md don't apply here. Task templates,
 * oracle solutions, and agent-authored tests ARE Effect-native alchemy code.
 */

export type HarnessName = "claude-code" | "codex" | "opencode" | "pi";

export interface HarnessConfig {
  readonly name: HarnessName;
  readonly enabled: boolean;
  readonly models: readonly string[];
}

export interface Budgets {
  readonly wallClockMs: number;
  readonly maxTurns: number;
  readonly budgetUsd: number;
}

export interface EvalsConfig {
  readonly harnesses: readonly HarnessConfig[];
  readonly trials: number;
  readonly budgets: Budgets;
}

export interface TaskManifest {
  readonly id: string;
  readonly version: number;
  readonly family: string;
  readonly difficulty: "easy" | "medium" | "hard";
  /**
   * Prompt style: "user" = a few sentences in the customer's voice, graded
   * at the product level by a verifier agent against hidden verify/intent.md;
   * "spec" = pinned API contract graded by deterministic verify/checks.ts.
   */
  readonly mode: "user" | "spec";
  /** Task-level overrides for the config budgets. */
  readonly budgets?: Partial<Budgets>;
  /** Stack output names the contract requires (e.g. ["url"]). */
  readonly requiredOutputs: readonly string[];
  /** Check ids (from checks.ts or intent.md) that must pass for e2ePass. */
  readonly mustPassChecks: readonly string[];
  /** Doc pages this task depends on (failure attribution hints). */
  readonly docTags: readonly string[];
}

export interface AgentJob {
  /** Absolute path to the rendered PROMPT.md inside the workspace. */
  readonly promptFile: string;
  /** Isolated workspace directory (cwd for the harness). */
  readonly cwd: string;
  readonly model: string;
  /** Full environment for the harness process (no inheritance). */
  readonly env: Record<string, string>;
  /** Hard kill after this many ms; always enforced by the runner. */
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly budgetUsd: number;
  /** Raw harness output stream is teed here verbatim. */
  readonly transcriptPath: string;
}

export type TerminationReason =
  | "completed"
  | "timeout"
  | "budget"
  | "max_turns"
  | "crash"
  | "hang_killed";

export interface AgentUsage {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

export interface AgentRunResult {
  readonly terminationReason: TerminationReason;
  readonly exitCode: number | null;
  readonly finalMessage: string | undefined;
  readonly usage: AgentUsage;
  readonly costUsd: number | undefined;
  readonly turns: number | undefined;
  readonly wallClockMs: number;
}

export interface HarnessAdapter {
  readonly name: HarnessName;
  /** `harness --version` output; results are not comparable across versions. */
  version(): Promise<string>;
  run(job: AgentJob): Promise<AgentRunResult>;
}

export interface CheckResult {
  readonly id: string;
  readonly pass: boolean;
  readonly detail?: string;
}

/** Context handed to a task's verify/checks.ts `run` export. */
export interface VerifyContext {
  readonly url: string;
  readonly outputs: Record<string, unknown>;
}

export interface LayerResults {
  readonly l0Static: { pass: boolean; detail?: string };
  readonly l1Deploy: {
    pass: boolean;
    deployMs?: number;
    outputsPresent: boolean;
    detail?: string;
  };
  readonly l2Health: { pass: boolean; detail?: string };
  readonly l3Functional: {
    ran: boolean;
    passed: number;
    total: number;
    checks: CheckResult[];
  };
  readonly l5AgentTests: {
    present: boolean;
    usesHarness: boolean;
    passed: boolean;
    detail?: string;
  };
  readonly destroy: { attempted: boolean; clean: boolean; detail?: string };
}

export interface TrialRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly family: string;
  readonly harness: HarnessName | "oracle";
  readonly harnessVersion: string;
  readonly model: string;
  readonly condition: string;
  /** The docs URL handed to the agent — the docs-iteration axis. */
  readonly docsUrl: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly terminationReason: TerminationReason | "oracle";
  readonly turns?: number;
  readonly tokensIn: number;
  readonly tokensCachedIn: number;
  readonly tokensOut: number;
  readonly agentCostUsd?: number;
  readonly agentWallClockMs: number;
  readonly layers: LayerResults;
  readonly score: number;
  readonly e2ePass: boolean;
  readonly workspacePath: string;
  readonly transcriptPath?: string;
}
