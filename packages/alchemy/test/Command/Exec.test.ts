import { DestroyError } from "@/Apply";
import * as Command from "@/Command";
import * as Provider from "@/Provider";
import { Stack } from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Command.providers() });

const FIXTURE_DIR = pathe.resolve(import.meta.dirname, "exec-fixture");

// Copy the fixture into a scoped temp directory so each run starts clean and
// the suite never mutates the committed source tree (the command appends to
// `runs.log` and the test rewrites `src/input.txt`).
const makeTemporaryFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tempDir = yield* fs.makeTempDirectoryScoped();
  yield* fs.copy(FIXTURE_DIR, tempDir);
  return { cwd: tempDir };
});

const countLines = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return 0;
  const content = yield* fs.readFileString(file);
  return content.split("\n").filter((line) => line.length > 0).length;
});

const readStateRow = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const currentStack = yield* Stack;
  return yield* state.get({
    stack: currentStack.name,
    stage: currentStack.stage,
    fqn,
  });
});

const deleteFailedWithCommandError = (error: unknown): boolean =>
  error instanceof DestroyError &&
  error.failures.some((failure) =>
    failure.cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) &&
        reason.error instanceof Command.CommandError,
    ),
  );

test.provider(
  "list returns [] for non-listable Command.Exec",
  () =>
    Effect.gen(function* () {
      // Command.Exec is a local side-effect step with no remote enumeration
      // API, so list() is the non-listable pattern: always returns [].
      const provider = yield* Provider.findProvider(Command.Exec);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { timeout: 30000 },
);

test.provider(
  "runs on file, env, and command changes; delete leaves side effects alone",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* stack.destroy();

      const fixture = yield* makeTemporaryFixture();
      const runsLog = pathe.join(fixture.cwd, "runs.log");
      const inputFile = pathe.join(fixture.cwd, "src", "input.txt");

      // The command appends a line per run; counting lines tells us exactly
      // how many times the command actually executed.
      const countRuns = Effect.gen(function* () {
        if (!(yield* fs.exists(runsLog))) return 0;
        const content = yield* fs.readFileString(runsLog);
        return content.split("\n").filter((line) => line.length > 0).length;
      });

      const deploy = (props: { command?: string; env?: { MARKER: string } }) =>
        stack.deploy(
          Command.Exec("test-exec", {
            command: props.command ?? "bash run.sh",
            shell: true,
            cwd: fixture.cwd,
            env: props.env ?? { MARKER: "first" },
            memo: { include: ["src/**"] },
          }),
        );

      const exec1 = yield* deploy({});

      // Memoization is enabled, so the input-file hash is recorded.
      expect(exec1.hash.input).toEqual(expect.any(String));
      expect(yield* countRuns).toBe(1);

      // Unchanged inputs — the run is skipped.
      const exec2 = yield* deploy({});
      expect(exec2.hash.input).toBe(exec1.hash.input);
      expect(yield* countRuns).toBe(1);

      // An env-only change re-runs (e.g. a recreated database's connection URL
      // with identical files). The hash tracks input files only, so it is
      // unchanged — the re-run is driven by the prop change, not the hash.
      const exec3 = yield* deploy({ env: { MARKER: "second" } });
      expect(yield* countRuns).toBe(2);
      expect(exec3.hash.input).toBe(exec1.hash.input);

      // A command-only change re-runs.
      const exec4 = yield* deploy({
        command: "bash run.sh second-run",
        env: { MARKER: "second" },
      });
      expect(yield* countRuns).toBe(3);
      expect(exec4.hash.input).toBe(exec3.hash.input);

      // A memoized input file change re-runs and changes the input hash.
      yield* fs.writeFileString(inputFile, "two\n");
      const exec5 = yield* deploy({
        command: "bash run.sh second-run",
        env: { MARKER: "second" },
      });
      expect(yield* countRuns).toBe(4);
      expect(exec5.hash.input).not.toBe(exec4.hash.input);

      // Destroy never reverses the command's side effects…
      yield* stack.destroy();
      expect(yield* countRuns).toBe(4);

      // …and forgets the run key, so an unchanged redeploy runs again.
      const exec6 = yield* deploy({
        command: "bash run.sh second-run",
        env: { MARKER: "second" },
      });
      expect(yield* countRuns).toBe(5);
      expect(exec6.hash.input).toBe(exec5.hash.input);

      yield* stack.destroy();
    }),
  { timeout: 60000 },
);

test.provider(
  "destroyCommand runs on delete with the deployed cwd and env",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* stack.destroy();

      const tempDir = yield* fs.makeTempDirectoryScoped();
      const marker = pathe.join(tempDir, "destroyed.txt");

      yield* stack.deploy(
        Command.Exec("destroy-exec", {
          command: "true",
          destroyCommand: 'printf "%s" "$MARKER" > destroyed.txt',
          shell: true,
          cwd: tempDir,
          env: { MARKER: "final" },
          memo: false,
        }),
      );

      // Deploy must not run destroyCommand.
      expect(yield* fs.exists(marker)).toBe(false);

      // Destroy runs it once, in the deployed cwd, with the deployed env.
      yield* stack.destroy();
      expect(yield* fs.readFileString(marker)).toBe("final");
    }),
  { timeout: 30000 },
);

for (const memo of [true, false]) {
  test.provider(
    `a destroyCommand-only edit persists without re-running command (memo: ${memo})`,
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        yield* stack.destroy();

        const fixture = yield* makeTemporaryFixture();
        const runsLog = pathe.join(fixture.cwd, "runs.log");
        const destroyLog = pathe.join(fixture.cwd, "destroy.log");

        const deploy = (destroyCommand: string) =>
          stack.deploy(
            Command.Exec("destroy-edit", {
              command: "bash run.sh",
              destroyCommand,
              shell: true,
              cwd: fixture.cwd,
              memo: memo ? { include: ["src/**"] } : false,
            }),
          );

        const exec1 = yield* deploy("echo A >> destroy.log");
        expect(yield* countLines(runsLog)).toBe(1);

        const exec2 = yield* deploy("echo B >> destroy.log");
        expect(yield* countLines(runsLog)).toBe(1);
        expect(exec2.hash.input).toBe(exec1.hash.input);

        yield* stack.destroy();
        expect(yield* fs.readFileString(destroyLog)).toBe("B\n");
      }),
    { timeout: 60000 },
  );
}

test.provider(
  "a failing destroyCommand fails destroy and keeps the state row",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* stack.destroy();

      const tempDir = yield* fs.makeTempDirectoryScoped();

      const deploy = (destroyCommand: string) =>
        stack.deploy(
          Command.Exec("failing-destroy", {
            command: "true",
            destroyCommand,
            shell: true,
            cwd: tempDir,
            memo: false,
          }),
        );

      yield* deploy("exit 3");

      const error = yield* Effect.flip(stack.destroy());
      expect(deleteFailedWithCommandError(error)).toBe(true);
      expect(yield* readStateRow("failing-destroy")).toBeDefined();

      yield* deploy("true");
      yield* stack.destroy();
      expect(yield* readStateRow("failing-destroy")).toBeUndefined();
    }),
  { timeout: 60000 },
);
