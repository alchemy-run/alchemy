import { PlatformServices } from "@/Util/PlatformServices.ts";
import { exec } from "@/Util/exec.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const fixturesDirectory = new URL("./fixtures/", import.meta.url);
const configPath = fileURLToPath(
  new URL("vitest-cleanup-order.config.ts", fixturesDirectory),
);

const runVitestFixture = (
  fixtureName: string,
  hooks: "stack" | "list" = "stack",
) =>
  exec(
    ChildProcess.make(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        fileURLToPath(new URL(fixtureName, fixturesDirectory)),
        "--config",
        configPath,
        `--sequence.hooks=${hooks}`,
        "--reporter=verbose",
      ],
      { shell: false },
    ),
  ).pipe(Effect.scoped);

const processOutput = (result: {
  readonly stdout: string;
  readonly stderr: string;
}) => `${result.stdout}\n${result.stderr}`;

describe("Vitest fallback cleanup", () => {
  test.live(
    "runs after user afterAll hooks for stack and list ordering",
    () =>
      Effect.gen(function* () {
        for (const hooks of ["stack", "list"] as const) {
          const result = yield* runVitestFixture(
            "vitest-cleanup-order.fixture.ts",
            hooks,
          );

          expect(result.exitCode).toBe(0);
          expect(processOutput(result)).toContain(
            "VITEST_CLEANUP_ORDER:user afterAll,alchemy fallback cleanup",
          );
        }
      }).pipe(Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );

  test.live(
    "runs when a later beforeAll hook fails",
    () =>
      Effect.gen(function* () {
        const result = yield* runVitestFixture(
          "vitest-cleanup-after-failed-before-all.fixture.ts",
        );
        const output = processOutput(result);

        expect(result.exitCode).toBe(1);
        expect(output).toContain("EXPECTED_BEFORE_ALL_FAILURE");
        expect(output).toContain("VITEST_CLEANUP_AFTER_FAILED_BEFORE_ALL");
      }).pipe(Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );

  test.live(
    "runs when an afterAll hook fails",
    () =>
      Effect.gen(function* () {
        const result = yield* runVitestFixture(
          "vitest-cleanup-after-failed-after-all.fixture.ts",
        );
        const output = processOutput(result);

        expect(result.exitCode).toBe(1);
        expect(output).toContain("EXPECTED_AFTER_ALL_FAILURE");
        expect(output).toContain("VITEST_CLEANUP_AFTER_FAILED_AFTER_ALL");
      }).pipe(Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );
});
