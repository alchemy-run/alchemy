import { exec } from "alchemy/Util/exec";
import * as Effect from "effect/Effect";
import type * as ChildProcess from "effect/process/ChildProcess";

/** Runs a command to completion and collects its exit code and output. */
export const run = (command: ChildProcess.Command) => exec(command).pipe(Effect.scoped);

/** The output of {@link run} as one string, stderr after stdout. */
export const outputOf = (result: { readonly stdout: string; readonly stderr: string }) =>
  [result.stdout, result.stderr].filter((text) => text.trim() !== "").join("\n");
