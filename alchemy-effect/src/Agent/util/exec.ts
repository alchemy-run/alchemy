import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Command from "@effect/platform/Command";
import * as Stream from "effect/Stream";
import * as String from "effect/String";

export const exec = Effect.fn("exec")(function* (command: Command.Command) {
  const [exitCode, stdout, stderr] = yield* pipe(
    // Start running the command and return a handle to the running process
    Command.start(command),
    Effect.flatMap((process) =>
      Effect.all(
        [
          // Waits for the process to exit and returns
          // the ExitCode of the command that was run
          process.exitCode,
          // The standard output stream of the process
          runString(process.stdout),
          // The standard error stream of the process
          runString(process.stderr),
        ],
        { concurrency: 3 },
      ),
    ),
  );
  return { exitCode, stdout, stderr };
});

// Helper function to collect stream output as a string
const runString = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<string, E, R> =>
  stream.pipe(Stream.decodeText(), Stream.runFold(String.empty, String.concat));
