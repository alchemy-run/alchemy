import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../bin/cli.js", import.meta.url));

/**
 * Run the CLI with no TTY on any stdio and return its exit code. Each
 * invocation is a real `bun bin/cli.js` child with `ALCHEMY_HOME` pointed at
 * a throwaway directory, so these pin the exit-code contract scripts and
 * agents rely on — 0 only when the command completed — without touching the
 * real `~/.alchemy`.
 */
const exitCodeOf = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-exit-codes-",
    });
    const handle = yield* ChildProcess.make("bun", [CLI, ...args], {
      env: { ALCHEMY_HOME: home, ...env },
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
    });
    return yield* handle.exitCode;
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe("CLI exit codes", () => {
  it.live("bare `profile` without a terminal prints help and exits 1", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["profile"])).toBe(1);
    }),
  );

  it.live("bare `state` without a terminal prints help and exits 1", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["state"])).toBe(1);
    }),
  );

  it.live("--no-input is accepted and forces a plain, working run", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["--no-input", "profile", "list"])).toBe(0);
    }),
  );

  it.live("--help exits 0", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["--help"])).toBe(0);
    }),
  );

  it.live("provider check-env exits 1 when a required var is missing", () =>
    Effect.gen(function* () {
      expect(
        yield* exitCodeOf(["provider", "check-env", "--provider", "neon"], {
          NEON_API_KEY: "",
        }),
      ).toBe(1);
    }),
  );

  it.live("provider check-env exits 0 when the contract is satisfied", () =>
    Effect.gen(function* () {
      expect(
        yield* exitCodeOf(["provider", "check-env", "--provider", "neon"], {
          NEON_API_KEY: "napi_test_key",
        }),
      ).toBe(0);
    }),
  );

  it.live("provider check-env accepts an explicit profile", () =>
    Effect.gen(function* () {
      expect(
        yield* exitCodeOf(
          [
            "provider",
            "check-env",
            "--profile",
            "default",
            "--provider",
            "neon",
          ],
          { NEON_API_KEY: "napi_test_key" },
        ),
      ).toBe(0);
    }),
  );
});
