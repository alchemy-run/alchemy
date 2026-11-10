/** Terminal-emulator features shared by CLI components. */
import { createChalk, truncateAnsi, type ChalkInstance } from "@alchemy.run/sigil/ansi";
import { detectColorLevel, detectUnicodeSupport } from "@alchemy.run/sigil/capabilities";
import { copyToClipboard as copyThroughTerminal } from "@alchemy.run/sigil/terminal";

/**
 * The canonical color-support decision, shared by raw terminal strings and
 * terminal capability detection so the two can never disagree.
 */
export const colorsEnabled = (
  stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
): boolean => detectColorLevel(stream) > 0;

/** The canonical Unicode-support decision for raw terminal strings. */
export const unicodeEnabled = detectUnicodeSupport;

/**
 * Environment override for child processes whose piped output returns here:
 * forwards this terminal's color level, since the child only sees a pipe.
 */
export const pipedColorEnv = (): Record<string, string> => {
  const level = detectColorLevel(process.stdout);
  return level > 0 ? { FORCE_COLOR: process.env.FORCE_COLOR ?? String(level) } : {};
};

/**
 * Chainable styles for raw, non-layout output (`style.bold.hex("#e28a5b")(text)`),
 * with the color level detected for `stream`. `colors` overrides detection:
 * `true` is truecolor, `false` plain text.
 */
export const terminalStyle = (
  options: {
    readonly stream?: Pick<NodeJS.WriteStream, "isTTY">;
    readonly colors?: boolean;
  } = {},
): ChalkInstance =>
  options.colors === undefined
    ? createChalk({ stream: options.stream ?? process.stdout })
    : createChalk({ level: options.colors ? "truecolor" : "none" });

/**
 * Copy to the user's clipboard: OSC 52 (wrapped for tmux or screen), tmux's
 * own buffer, and the system clipboard tool for local sessions.
 */
export const copyToClipboard = (
  text: string,
  stdout: { write(data: string): boolean } = process.stdout,
): void => {
  copyThroughTerminal(text, { stream: stdout });
};

/** Display-width-aware truncation (wide CJK/emoji count by rendered cells). */
export const truncate = (value: string, width: number): string =>
  truncateAnsi(value, Math.max(4, width));
