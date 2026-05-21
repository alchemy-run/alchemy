import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import {
  assertPidExited,
  isAlive,
  killPid,
  pidListeningOn,
  spawnScoped,
  waitForExit,
  type SpawnedProcess,
} from "./fixtures/process-effect.ts";
import { runtimes } from "./fixtures/runtimes.ts";

const PARENT_TS = fileURLToPath(
  new URL("./fixtures/rpc-spawner-parent.ts", import.meta.url),
);
const CHILD_TS_URL = new URL(
  "./fixtures/rpc-server-entry.ts",
  import.meta.url,
).toString();

for (const runtime of runtimes()) {
  describe(`Local.RpcSpawner cleanup (${runtime.name})`, () => {
    const launch = startParent([...runtime.argv(PARENT_TS), CHILD_TS_URL]).pipe(
      Effect.tap(({ childPid }) =>
        Effect.addFinalizer(() =>
          // The child should die with its parent, but if a test fails
          // or interrupts mid-flight, make sure we don't leak a real
          // RPC server.
          Effect.flatMap(isAlive(childPid), (alive) =>
            alive ? killPid(childPid, "SIGKILL") : Effect.void,
          ),
        ),
      ),
    );

    it.live(
      "child dies after parent receives SIGTERM",
      () =>
        Effect.gen(function* () {
          const { proc, parentPid, childPid } = yield* launch;
          expect(yield* isAlive(childPid)).toBe(true);
          yield* killPid(parentPid, "SIGTERM");
          // waitForExit wraps `handle.exitCode`, which resolves once
          // the OS reports the parent's exit.
          yield* waitForExit(proc, Duration.seconds(10));
          yield* assertPidExited(childPid);
        }).pipe(Effect.provide(PlatformServices)),
      { timeout: 45_000 },
    );

    it.live(
      "child dies after parent receives SIGKILL",
      () =>
        Effect.gen(function* () {
          const { proc, parentPid, childPid } = yield* launch;
          expect(yield* isAlive(childPid)).toBe(true);
          yield* killPid(parentPid, "SIGKILL");
          yield* waitForExit(proc, Duration.seconds(10));
          yield* assertPidExited(childPid);
        }).pipe(Effect.provide(PlatformServices)),
      { timeout: 45_000 },
    );
  });
}

/**
 * Boots the parent fixture and waits until it has reported both its own
 * pid and the child's RPC url (from which we resolve the child's pid via
 * `lsof`). Retries the stdout parse on a schedule until both fields are
 * populated.
 */
const startParent = (
  argv: ReadonlyArray<string>,
): Effect.Effect<
  {
    readonly proc: SpawnedProcess;
    readonly parentPid: number;
    readonly childPid: number;
  },
  Error,
  Scope.Scope | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const proc = yield* spawnScoped(argv).pipe(Effect.orDie);

    const parse = Effect.gen(function* () {
      const running = yield* proc.handle.isRunning.pipe(
        Effect.orElseSucceed(() => false),
      );
      if (!running) {
        const stderr = yield* proc.stderr;
        return yield* Effect.fail(
          new Error(
            `parent exited before reporting CHILD_URL. stderr=${stderr}`,
          ),
        );
      }
      const stdout = yield* proc.stdout;
      const childUrlMatch = stdout.match(/CHILD_URL=(\S+)/);
      const parentPidMatch = stdout.match(/PARENT_PID=(\d+)/);
      if (!childUrlMatch || !parentPidMatch) {
        return yield* Effect.fail(new Error("parent has not reported yet"));
      }
      const childPid = yield* pidListeningOn(childUrlMatch[1]!);
      if (childPid === undefined) {
        return yield* Effect.fail(new Error("child not yet listening"));
      }
      return {
        proc,
        parentPid: Number.parseInt(parentPidMatch[1]!, 10),
        childPid,
      };
    });

    return yield* parse.pipe(
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(100)),
        times: 300,
      }),
      Effect.catch((e) =>
        Effect.flatMap(proc.stderr, (stderr) =>
          Effect.fail(
            new Error(
              `parent never reported CHILD_URL: ${e.message}. stderr=${stderr}`,
            ),
          ),
        ),
      ),
    );
  });
