import { runMain } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";

const mode = process.argv[2] ?? "success";
const writeOutput = Effect.sync(() => {
  if (mode === "ended" || mode === "destroyed") {
    // Teardown must not wait forever on an already-closed stream.
    if (mode === "ended") process.stdout.end();
    else process.stdout.destroy();
    return;
  }
  // Both writes exceed the pipe buffer, so a forced exit would cut them off.
  process.stdout.write(JSON.stringify({ payload: "x".repeat(8 * 1024 * 1024), end: "complete" }));
  process.stderr.write("y".repeat(1024 * 1024) + "stderr-complete");
});

runMain(
  mode === "failure"
    ? writeOutput.pipe(Effect.flatMap(() => Effect.fail(new Error("expected teardown failure"))))
    : writeOutput,
);
