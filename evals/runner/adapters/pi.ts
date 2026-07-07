import { readFileSync } from "node:fs";
import type {
  AgentJob,
  AgentRunResult,
  HarnessAdapter,
  TerminationReason,
} from "../types.ts";
import { commandVersion, spawnTeed } from "./spawn.ts";

/**
 * Pi coding agent adapter (@mariozechner/pi-coding-agent).
 *
 * UNVERIFIED — flag surface written against pi 0.73.x (`pi -p` print mode,
 * `--model` selection). Auth via ANTHROPIC_API_KEY / OPENAI_API_KEY in the
 * job env (doppler provides both).
 */
export const pi: HarnessAdapter = {
  name: "pi",

  version: () => commandVersion(["pi", "--version"]),

  async run(job: AgentJob): Promise<AgentRunResult> {
    const prompt = readFileSync(job.promptFile, "utf8");
    const result = await spawnTeed({
      cmd: ["pi", "-p", "--model", job.model, prompt],
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
