import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import {
  ChildProcessSpawner,
  type ChildProcessHandle,
} from "effect/unstable/process/ChildProcessSpawner";

/**
 * Effect-shaped helpers for driving real OS child processes in tests.
 *
 * Built on top of `effect/unstable/process` so spawn, stream buffering,
 * exit-code tracking, and signal delivery all flow through the Effect
 * runtime. Callers must provide a `ChildProcessSpawner` (e.g. via
 * `PlatformServices`).
 */

export interface SpawnedProcess {
  readonly handle: ChildProcessHandle;
  /** Snapshot of accumulated stdout (utf-8). */
  readonly stdout: Effect.Effect<string>;
  /** Snapshot of accumulated stderr (utf-8). */
  readonly stderr: Effect.Effect<string>;
}

/**
 * Spawn a child process, fork stdout/stderr into in-memory buffers, and
 * register a SIGTERM/SIGKILL finalizer. The handle's own lifecycle is
 * already scope-bound by `ChildProcessSpawner`, so the surrounding
 * `Effect.scoped` is all that's needed for cleanup.
 */
export const spawnScoped = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
): Effect.Effect<
  SpawnedProcess,
  PlatformError.PlatformError,
  Scope.Scope | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(argv[0]!, argv.slice(1), {
      env,
      extendEnv: true,
      // We never write to the child's stdin, so close it. stdout/stderr
      // default to "pipe" which is what we want for the buffering forks
      // below.
      stdin: "ignore",
      // SIGTERM first, escalate to SIGKILL after 1s if the child hasn't
      // exited. Matches the behavior of the old hand-rolled finalizer.
      killSignal: "SIGTERM",
      forceKillAfter: Duration.seconds(1),
    });

    const stdoutRef = yield* Ref.make("");
    const stderrRef = yield* Ref.make("");

    yield* Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
      Ref.update(stdoutRef, (s) => s + chunk),
    ).pipe(Effect.ignore, Effect.forkScoped);
    yield* Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
      Ref.update(stderrRef, (s) => s + chunk),
    ).pipe(Effect.ignore, Effect.forkScoped);

    return {
      handle,
      stdout: Ref.get(stdoutRef),
      stderr: Ref.get(stderrRef),
    } satisfies SpawnedProcess;
  });

/**
 * Poll the accumulated stdout for a regex match. Fails if the child
 * exits before producing a match or if the timeout elapses.
 */
export const waitForStdoutMatch = (
  proc: SpawnedProcess,
  pattern: RegExp,
  timeout: Duration.Input,
): Effect.Effect<RegExpMatchArray, Error, ChildProcessSpawner> => {
  const interval = Duration.millis(50);
  const totalMs = Duration.toMillis(timeout);
  const attempts = Math.max(
    1,
    Math.ceil(totalMs / Duration.toMillis(interval)),
  );
  const checkOnce: Effect.Effect<RegExpMatchArray, Error, ChildProcessSpawner> =
    Effect.gen(function* () {
      const stdout = yield* proc.stdout;
      const m = stdout.match(pattern);
      if (m) return m;
      const running = yield* proc.handle.isRunning.pipe(
        Effect.orElseSucceed(() => false),
      );
      if (!running) {
        const stderr = yield* proc.stderr;
        return yield* Effect.fail(
          new Error(
            `child exited before stdout matched ${pattern}. stderr=${stderr}`,
          ),
        );
      }
      return yield* Effect.fail(new Error("no match yet"));
    });
  return checkOnce.pipe(
    Effect.retry({ schedule: Schedule.spaced(interval), times: attempts }),
    Effect.catch((e) =>
      Effect.flatMap(proc.stderr, (stderr) =>
        Effect.fail(
          new Error(
            `timeout waiting for ${pattern}: ${e.message}. stderr=${stderr}`,
          ),
        ),
      ),
    ),
  );
};

/**
 * Wait for the child to exit (with timeout). Uses `handle.isRunning`
 * rather than `handle.exitCode` because the latter raises a
 * `PlatformError` for processes killed by signal (no exit code), which
 * is a perfectly normal outcome for the SIGKILL test cases.
 */
export const waitForExit = (
  proc: SpawnedProcess,
  timeout: Duration.Input,
): Effect.Effect<void, Error> =>
  proc.handle.isRunning.pipe(
    Effect.orElseSucceed(() => false),
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(50)),
      until: (running) => !running,
    }),
    Effect.timeout(timeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error("child did not exit in time")),
    ),
  );

export const assertPidExited = (pid: number): Effect.Effect<void, Error> =>
  isAlive(pid).pipe(
    Effect.orElseSucceed(() => false),
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(50)),
      until: (alive) => !alive,
    }),
    Effect.timeout("5 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error("child did not exit in time")),
    ),
  );

/**
 * `process.kill(pid, 0)` is a sync syscall that probes a pid we don't
 * own a handle to (e.g. a grandchild spawned by the parent fixture).
 * Wrapped in `Effect.sync` so it participates in the runtime.
 */
export const isAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Resolves the pid currently LISTENing on the port of `wsUrl`. Uses an
 * `lsof` invocation; we don't own a handle to whatever process is
 * listening so there's no ChildProcessHandle equivalent.
 */
export const pidListeningOn = (wsUrl: string) =>
  ChildProcess.make(
    "lsof",
    ["-iTCP:" + new URL(wsUrl).port, "-sTCP:LISTEN", "-t"],
    {
      stdout: "pipe",
    },
  ).pipe(
    Effect.flatMap((handle) =>
      handle.stdout.pipe(Stream.decodeText, Stream.mkString),
    ),
    Effect.map((stdout) => Number.parseInt(stdout.trim().split("\n")[0]!, 10)),
  );

/** Send a signal to a pid we don't own a handle to. */
export const killPid = (
  pid: number,
  signal: NodeJS.Signals,
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, signal);
    } catch {}
  });

/**
 * Open a WebSocket inside a scope so it's reliably closed at scope
 * end. Resolves once `open` fires or fails on error / close.
 */
export const openWebSocket = (
  url: string | URL,
): Effect.Effect<WebSocket, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, Error>((resume) => {
      const ws = new WebSocket(url);
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resume(Effect.succeed(ws));
      };
      const onError = () => {
        cleanup();
        try {
          ws.close();
        } catch {}
        resume(Effect.fail(new Error(`websocket connect failed: ${url}`)));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    }),
    (ws) =>
      Effect.sync(() => {
        try {
          ws.close();
        } catch {}
      }),
  );

/** Probe whether a websocket can be opened. Never fails. */
export const canOpenWebSocket = (
  url: string | URL,
  timeout: Duration.Input = Duration.millis(1_500),
): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const ws = new WebSocket(url);
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      resume(Effect.succeed(v));
    };
    ws.addEventListener("open", () => settle(true), { once: true });
    ws.addEventListener("error", () => settle(false), { once: true });
    ws.addEventListener("close", () => settle(false), { once: true });
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.succeed(false),
    }),
  );
