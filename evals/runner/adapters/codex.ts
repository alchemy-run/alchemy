import { readFileSync } from "node:fs";
import type {
  AgentJob,
  AgentRunResult,
  HarnessAdapter,
  TerminationReason,
} from "../types.ts";
import { commandVersion, spawnTeed } from "./spawn.ts";

/**
 * OpenAI Codex CLI adapter (`codex exec`).
 *
 * UNVERIFIED against a live login (blocked on `codex logout && codex login`);
 * flag surface written against codex-cli 0.142.x. Auth: ChatGPT login state
 * in ~/.codex, or OPENAI_API_KEY in the job env.
 */
export const codex: HarnessAdapter = {
  name: "codex",

  version: () => commandVersion(["codex", "--version"]),

  async run(job: AgentJob): Promise<AgentRunResult> {
    const prompt = readFileSync(job.promptFile, "utf8");
    const result = await spawnTeed({
      cmd: [
        "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "danger-full-access",
        "-m",
        job.model,
        "-C",
        job.cwd,
        "-", // read the prompt from stdin
      ],
      cwd: job.cwd,
      env: job.env,
      stdin: prompt,
      timeoutMs: job.timeoutMs,
      stallMs: 5 * 60_000,
      transcriptPath: job.transcriptPath,
    });

    // JSONL events; accumulate usage from turn.completed events.
    let input = 0;
    let cachedInput = 0;
    let output = 0;
    let turns = 0;
    let finalMessage: string | undefined;
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const usage = event?.usage ?? event?.info?.usage ?? event?.msg?.usage;
        if (usage) {
          turns += 1;
          input += usage.input_tokens ?? 0;
          cachedInput += usage.cached_input_tokens ?? 0;
          output += usage.output_tokens ?? 0;
        }
        const text =
          event?.msg?.message ?? event?.item?.text ?? event?.message;
        if (typeof text === "string") finalMessage = text;
      } catch {
        // tolerated; raw transcript keeps everything
      }
    }

    let terminationReason: TerminationReason;
    if (result.timedOut) terminationReason = "timeout";
    else if (result.stalled) terminationReason = "hang_killed";
    else terminationReason = result.exitCode === 0 ? "completed" : "crash";

    return {
      terminationReason,
      exitCode: result.exitCode,
      finalMessage,
      usage: { input, cachedInput, output },
      costUsd: undefined, // priced from usage later; codex reports no native cost
      turns: turns > 0 ? turns : undefined,
      wallClockMs: result.wallClockMs,
    };
  },
};
