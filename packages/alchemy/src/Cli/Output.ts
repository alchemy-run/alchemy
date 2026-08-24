import type * as ConsoleService from "effect/Console";
import * as Effect from "effect/Effect";
import { makeLineBuffer } from "../Util/LineBuffer.ts";
import { linePrefix } from "./CliKit/index.ts";

export type OutputChannel = "stdout" | "stderr";

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
    stdout: makeLineBuffer(writeLine),
    stderr: makeLineBuffer(writeLine),
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
  return (_channel: OutputChannel, line: string) =>
    Effect.logInfo(`${prefix} ${line}`);
};
