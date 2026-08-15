import type * as ConsoleService from "effect/Console";
import * as Effect from "effect/Effect";
import { linePrefix } from "./CliKit/index.ts";

export type OutputChannel = "stdout" | "stderr";

/**
 * Buffers stream chunks and emits complete lines (split on `\n`, `\r\n`,
 * or bare `\r` so progress-style output still flows). `flush` emits any
 * trailing partial line — call it when the source closes.
 */
export const makeLineSplitter = (onLine: (line: string) => void) => {
  let buffer = "";
  return {
    push: (chunk: string): void => {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop()!;
      for (const line of lines) onLine(line);
    },
    flush: (): void => {
      if (buffer !== "") {
        onLine(buffer);
        buffer = "";
      }
    },
  };
};

/**
 * The single terminal-output pipeline for resource-owned processes. Dev
 * servers, local workers, and deploy-time builders all use the same line
 * splitting, resource prefix, color policy, and stdout/stderr severity.
 */
export const makeResourceOutput = (
  id: string,
  console: Pick<ConsoleService.Console, "log">,
) => {
  const prefix = linePrefix(id);
  // stderr is a process transport, not a semantic failure: Vite and many
  // other tools write warnings, progress, and ordinary diagnostics there.
  // Sending it through Console.error makes CLIKit prepend an error glyph to
  // every line. Both streams therefore enter the renderer as plain resource
  // output; the child text retains its own ANSI severity styling.
  const writeLine = (line: string) => console.log(`${prefix} ${line}`);
  return {
    stdout: makeLineSplitter(writeLine),
    stderr: makeLineSplitter(writeLine),
  };
};

/**
 * Effect-native output for resource-owned child processes whose streams are
 * already consumed inside an Effect. Both process channels are transport
 * details, not semantic severity, so they enter the configured logger at the
 * info level. The logger remains responsible for terminal and file sinks.
 */
export const makeResourceLogger = (id: string) => {
  const prefix = `[${id}]`;
  return (_channel: OutputChannel, line: string): Effect.Effect<void> =>
    Effect.logInfo(`${prefix} ${line}`);
};
