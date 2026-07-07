import { readFileSync } from "node:fs";
import type {
  AgentJob,
  AgentRunResult,
  HarnessAdapter,
  TerminationReason,
} from "../types.ts";
import { commandVersion, spawnTeed } from "./spawn.ts";

/**
 * opencode adapter (`opencode run`).
 *
 * UNVERIFIED end-to-end (smoke-tested for chat, not for an agentic build).
 * Model ids are provider-scoped, e.g. "anthropic/claude-fable-5". Transcript
 * is plain text; opencode exposes no per-run usage on stdout, so usage stays
 * zero and cost undefined until we wire its JSON event stream.
 */
export const opencode: HarnessAdapter = {
  name: "opencode",

  version: () => commandVersion(["opencode", "--version"]),

  async run(job: AgentJob): Promise<AgentRunResult> {
    const prompt = readFileSync(job.promptFile, "utf8");
    const result = await spawnTeed({
      cmd: ["opencode", "run", "-m", job.model, prompt],
      cwd: job.cwd,
      env: job.env,
      timeoutMs: job.timeoutMs,
      stallMs: 5 * 60_000,
      transcriptPath: job.transcriptPath,
    });

    let terminationReason: TerminationReason;
    if (result.timedOut) terminationReason = "timeout";
    else if (result.stalled) terminationReason = "hang_killed";
    else terminationReason = result.exitCode === 0 ? "completed" : "crash";

    return {
      terminationReason,
      exitCode: result.exitCode,
      finalMessage: result.stdout.trim().slice(-4000) || undefined,
      usage: { input: 0, cachedInput: 0, output: 0 },
      costUsd: undefined,
      turns: undefined,
      wallClockMs: result.wallClockMs,
    };
  },
};
