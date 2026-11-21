import { runMain } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";

const mode = process.argv[2] ?? "success";
const writeOutput = Effect.sync(() => {
  if (mode.startsWith("ended-") || mode.startsWith("destroyed-")) {
    // The teardown must not hang on pre-closed output streams even when an
    // unrelated provider handle keeps the process alive.
    setInterval(() => {}, 60_000);
    const stream = mode.endsWith("out") ? process.stdout : process.stderr;
    if (mode.startsWith("ended-")) stream.end();
    else stream.destroy();
    return;
  }
  // Both streams exceed the pipe high-water mark. The markers detect a
  // successful exit that silently cuts off the end of either stream.
  process.stdout.write(JSON.stringify({ payload: "x".repeat(8 * 1024 * 1024), end: "complete" }));
  process.stderr.write("y".repeat(1024 * 1024) + "stderr-complete");
  if (mode === "keepalive") {
    // Simulates provider sockets that can keep a successful CLI alive.
    setInterval(() => {}, 60_000);
  }
  if (mode === "exitCode") {
    process.exitCode = 7;
  }
  if (mode === "interrupt") {
    process.kill(process.pid, "SIGINT");
  }
});

runMain(
  mode === "failure"
    ? writeOutput.pipe(Effect.flatMap(() => Effect.fail(new Error("expected teardown failure"))))
    : mode === "interrupt"
      ? writeOutput.pipe(Effect.andThen(Effect.sleep("30 seconds")))
      : mode === "finalizer"
        ? Effect.acquireUseRelease(
            Effect.void,
            () => writeOutput,
            () => Effect.sync(() => process.stderr.write("FINALIZER_COMPLETE")),
          )
        : writeOutput,
);
