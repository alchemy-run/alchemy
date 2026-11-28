import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { nodePath, nodeSupportsDevMode } from "../nodeProbe.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-teardown.ts", import.meta.url));

const runFixture = (runtime: "bun" | "node", mode: string) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make(
      runtime === "node" ? nodePath! : "bun",
      runtime === "node" ? ["--experimental-strip-types", fixture, mode] : [fixture, mode],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: "2 seconds",
      },
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
        child.exitCode,
      ],
      { concurrency: 3 },
    );
    return { stdout, stderr, exitCode };
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe("runMain piped output", { tags: ["unit", "local"] }, () => {
  for (const runtime of ["bun", "node"] as const) {
    for (const mode of ["success", "failure"] as const) {
      it.live.skipIf(runtime === "node" && !nodeSupportsDevMode)(
        `${runtime} flushes stdout and stderr before ${mode} exit`,
        () =>
          Effect.gen(function* () {
            const { stdout, stderr, exitCode } = yield* runFixture(runtime, mode);
            const parsed = JSON.parse(stdout) as { payload: string; end: string };
            expect(parsed.payload).toHaveLength(8 * 1024 * 1024);
            expect(parsed.end).toBe("complete");
            expect(stderr).toContain("stderr-complete");
            expect(exitCode).toBe(mode === "failure" ? 1 : 0);
          }),
        { timeout: 20_000 },
      );
    }
    for (const mode of ["ended", "destroyed"] as const) {
      it.live.skipIf(runtime === "node" && !nodeSupportsDevMode)(
        `${runtime} exits when stdout was ${mode} before teardown`,
        () =>
          Effect.gen(function* () {
            const { exitCode } = yield* runFixture(runtime, mode);
            expect(exitCode).toBe(0);
          }),
        { timeout: 15_000 },
      );
    }
  }
});
