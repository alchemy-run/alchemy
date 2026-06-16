import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Cli } from "./Cli.ts";
import { LoggingCli } from "./LoggingCli.ts";

/**
 * Returns true when the current process looks like it's being driven by a
 * coding agent, CI runner, or anything else that won't render an interactive
 * TUI well. The Ink renderer repaints the screen on every event, which floods
 * agent transcripts with redundant frames; LoggingCli emits one line per
 * status change instead.
 */
export const isNonInteractive = (): boolean => {
  const env = process.env;
  if (env.ALCHEMY_PLAIN === "1" || env.ALCHEMY_NO_TUI === "1") return true;
  if (env.ALCHEMY_TUI === "1") return false;
  if (!process.stdout.isTTY) return true;
  if (env.CI) return true;
  // Known coding-agent env vars. These are best-effort — the isTTY check
  // above already catches most cases since agents typically pipe stdout.
  if (
    env.CLAUDECODE ||
    env.CLAUDE_CODE_ENTRYPOINT ||
    env.CURSOR_AGENT ||
    env.AIDER_MODEL ||
    env.CODEX_CLI
  )
    return true;
  return false;
};

export const selectCli = (): Layer.Layer<Cli> =>
  isNonInteractive()
    ? LoggingCli
    : // Defer importing the Ink/React TUI (`./tui/InkCLI.tsx` pulls in `ink`)
      // until we actually need the interactive renderer. Non-interactive runs
      // (agents, CI, piped output) take the cheap `LoggingCli` branch and never
      // pay the TUI import cost.
      Layer.unwrap(
        Effect.promise(() =>
          import("./tui/InkCLI.tsx").then((m) => m.inkCLI()),
        ),
      );
