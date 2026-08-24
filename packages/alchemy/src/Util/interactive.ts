/**
 * Returns true when the current process looks like it's being driven by a
 * coding agent, CI runner, test runner, or anything else that won't render an
 * interactive TUI / prompt well.
 *
 * This is the process-level source of truth used by CliKit capability
 * detection, auth configuration guards, and spawned-command stdin policy.
 *
 * Kept in `Util` (rather than `Cli`) so `Auth` can depend on it without
 * pulling in the CLI layer.
 */
export const isNonInteractive = (): boolean => {
  const env = process.env;
  // An explicit CLI flag beats every env-based heuristic. Checked via argv
  // because capability detection runs while the CLI's service layers are
  // built, before the command parser has produced flag values. Only scan up
  // to a `--` separator so a positional argument that happens to be the
  // literal text "--no-input" is not mistaken for the flag.
  const separator = process.argv.indexOf("--");
  const flagArgs =
    separator === -1 ? process.argv : process.argv.slice(0, separator);
  if (flagArgs.includes("--no-input")) return true;
  if (env.ALCHEMY_PLAIN === "1" || env.ALCHEMY_NO_TUI === "1") return true;
  if (env.ALCHEMY_TUI === "1") return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
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

export interface InteractionCapabilities {
  readonly input: boolean;
}

/** Process capabilities as an Effect so callers can replace them in tests. */
export const processInteractionCapabilities: Effect.Effect<InteractionCapabilities> =
  Effect.sync(() => ({ input: !isNonInteractive() }));

/** Select user-facing copy from an injected capability Effect. */
export const messageForCapabilities = <E, R>(
  capabilities: Effect.Effect<InteractionCapabilities, E, R>,
  interactive: string,
  nonInteractive: string,
): Effect.Effect<string, E, R> =>
  Effect.map(capabilities, ({ input }) =>
    input ? interactive : nonInteractive,
  );

/** Prefer the profile dashboard when this process can own a TUI screen. */
export const profileCommandHint = (nonInteractiveCommand: string) =>
  messageForCapabilities(
    processInteractionCapabilities,
    "alchemy profile",
    nonInteractiveCommand,
  );
import * as Effect from "effect/Effect";
