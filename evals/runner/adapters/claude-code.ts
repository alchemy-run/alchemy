import { readFileSync } from "node:fs";
import type {
  AgentJob,
  AgentRunResult,
  HarnessAdapter,
  TerminationReason,
} from "../types.ts";
import { commandVersion, spawnTeed } from "./spawn.ts";

/**
 * Claude Code headless adapter — the shipped CLI, as users run it.
 *
 * `claude -p` with stream-json output; the final `result` message carries
 * native cost, usage, and turn counts. `CLAUDE_CONFIG_DIR` is pointed at a
 * per-run directory by the caller so user-level skills/CLAUDE.md never leak
 * into the trial (auth comes from ANTHROPIC_API_KEY in the job env).
 */
export const claudeCode: HarnessAdapter = {
  name: "claude-code",

  version: () => commandVersion(["claude", "--version"]),

  async run(job: AgentJob): Promise<AgentRunResult> {
    const prompt = readFileSync(job.promptFile, "utf8");
    const result = await spawnTeed({
      cmd: [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        job.model,
        "--permission-mode",
        "bypassPermissions",
        "--max-turns",
        String(job.maxTurns),
      ],
      cwd: job.cwd,
      env: job.env,
      stdin: prompt,
      timeoutMs: job.timeoutMs,
      stallMs: 5 * 60_000,
      transcriptPath: job.transcriptPath,
    });

    // The last {"type":"result"} line is authoritative for cost/usage/turns.
    let final:
      | {
          subtype?: string;
          result?: string;
          total_cost_usd?: number;
          num_turns?: number;
          usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            output_tokens?: number;
          };
        }
      | undefined;
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "result") final = parsed;
      } catch {
        // non-JSON noise on stdout is tolerated; transcript keeps it verbatim
      }
    }

    let terminationReason: TerminationReason;
    if (result.timedOut) terminationReason = "timeout";
    else if (result.stalled) terminationReason = "hang_killed";
    else if (final?.subtype === "success") terminationReason = "completed";
    else if (final?.subtype === "error_max_turns") terminationReason = "max_turns";
    else if (final !== undefined) terminationReason = "crash";
    else terminationReason = result.exitCode === 0 ? "completed" : "crash";

    return {
      terminationReason,
      exitCode: result.exitCode,
      finalMessage: final?.result,
      usage: {
        input: final?.usage?.input_tokens ?? 0,
        cachedInput: final?.usage?.cache_read_input_tokens ?? 0,
        output: final?.usage?.output_tokens ?? 0,
      },
      costUsd: final?.total_cost_usd,
      turns: final?.num_turns,
      wallClockMs: result.wallClockMs,
    };
  },
};
