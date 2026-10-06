import * as Effect from "effect/Effect";
import type { ChildProcess } from "effect/process";
import * as Stream from "effect/Stream";

export const exec = Effect.fn("exec")(function* (command: ChildProcess.Command) {
  const handle = yield* command;
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  );
  return { exitCode, stdout, stderr };
});
