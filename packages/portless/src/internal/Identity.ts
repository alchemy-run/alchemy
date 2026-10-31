import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Host from "./Host.ts";
import { outputOf, run } from "./Run.ts";

/**
 * A process's start time in the encoding Portless records next to a route's
 * process group (`cli-utils.ts` `getProcessStartTime`): the pid and this value
 * together name one process, so a recycled pid is never taken for it.
 *
 * - Linux: field 22 of `/proc/<pid>/stat`, the start time in ticks since boot.
 * - macOS: the `ps -o lstart=` text, read in the C locale and UTC, with runs of
 *   whitespace folded to single spaces.
 *
 * `undefined` where Portless has none (Windows) or the process is gone.
 */
export const processStartTime = Effect.fn(function* (pid: number) {
  if (Host.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (Host.platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
    if (stat._tag === "None") return undefined;
    // Fields after the parenthesized command name; the start time is field 22.
    const fields = stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ");
    return fields[19] || undefined;
  }
  const result = yield* run(
    ChildProcess.make("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { LC_ALL: "C", TZ: "UTC" },
      extendEnv: true,
    }),
  ).pipe(Effect.option);
  if (result._tag === "None" || result.value.exitCode !== 0) return undefined;
  return (
    outputOf({ stdout: result.value.stdout, stderr: "" }).trim().replace(/\s+/g, " ") || undefined
  );
});
