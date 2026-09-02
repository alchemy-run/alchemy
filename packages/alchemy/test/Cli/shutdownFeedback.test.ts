import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/shutdown-feedback-fixture.ts", import.meta.url),
);

/**
 * Spawn the fixture (piped stdio, so the feedback takes the non-TTY log-line
 * branch), wait for its ready line, and expose accumulated stderr.
 */
const spawnFixture = (env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("bun", [FIXTURE], {
      env,
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
    });
    const chunks: string[] = [];
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.includes("ready")),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeout(Duration.seconds(10)),
    );
    return {
      handle,
      sigint: Effect.sync(() => process.kill(handle.pid, "SIGINT")),
      stderr: () => chunks.join(""),
    };
  });

const waitForStderr = (read: () => string, text: string) =>
  Effect.sync(read).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(50)),
      until: (output) => output.includes(text),
      times: 100,
    }),
    Effect.flatMap((output) =>
      output.includes(text)
        ? Effect.void
        : Effect.fail(
            new Error(
              `stderr never contained ${JSON.stringify(text)}: ${output}`,
            ),
          ),
    ),
  );

describe("shutdown feedback", () => {
  it.live(
    "a hanging shutdown surfaces feedback and a second SIGINT force-quits with 130",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture();
        yield* fixture.sigint;
        yield* waitForStderr(
          fixture.stderr,
          "Shutting down — waiting for cleanup",
        );
        yield* fixture.sigint;
        expect(yield* fixture.handle.exitCode).toBe(130);
        expect(fixture.stderr()).toContain("Force quitting.");
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );

  it.live(
    "a duplicate SIGINT within the feedback delay does not force-quit",
    () =>
      Effect.gen(function* () {
        // `node --watch` and pnpm forward the tty's SIGINT to their children,
        // so one ^C can be delivered twice back-to-back — that must read as
        // ONE press, not a force-quit.
        const fixture = yield* spawnFixture();
        yield* fixture.sigint;
        yield* fixture.sigint;
        yield* waitForStderr(
          fixture.stderr,
          "Shutting down — waiting for cleanup",
        );
        expect(fixture.stderr()).not.toContain("Force quitting");
        // A distinct press after the hint is visible still force-quits.
        yield* fixture.sigint;
        expect(yield* fixture.handle.exitCode).toBe(130);
        expect(fixture.stderr()).toContain("Force quitting.");
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );

  it.live(
    "a shutdown finishing within the delay stays silent",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          SHUTDOWN_FIXTURE_EXIT_AFTER_MS: "50",
        });
        yield* fixture.sigint;
        expect(yield* fixture.handle.exitCode).toBe(0);
        expect(fixture.stderr()).not.toContain("Shutting down");
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );

  it.live(
    "a suppressed process (dev supervisor) stays silent but still force-quits",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          SHUTDOWN_FIXTURE_SUPPRESS: "1",
        });
        yield* fixture.sigint;
        // Past the 200ms feedback delay — suppression must keep this quiet.
        yield* Effect.sleep(Duration.millis(500));
        expect(fixture.stderr()).not.toContain("Shutting down");
        yield* fixture.sigint;
        expect(yield* fixture.handle.exitCode).toBe(130);
        expect(fixture.stderr()).not.toContain("Force quitting");
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );
});
