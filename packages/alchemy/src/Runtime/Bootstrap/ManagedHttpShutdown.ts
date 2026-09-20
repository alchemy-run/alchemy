import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { Server } from "node:http";

/** Internal HTTP and dependency lifetimes, separate from managed run fibers. */
export class ManagedHttpShutdown extends Context.Service<
  ManagedHttpShutdown,
  {
    readonly scope: Scope.Closeable;
    readonly dependencies: Scope.Closeable;
    readonly servers: Set<Server>;
    readonly drainTimeoutMs: number;
    readonly isStopping: () => boolean;
    readonly observeRequest: (fiber: Fiber.Fiber<unknown, unknown>) => void;
    readonly runnerFinished: (
      exit: Exit.Exit<unknown, unknown>,
      last: boolean,
    ) => void;
  }
>()("Alchemy.Runtime.ManagedHttpShutdown") {}

export const withManagedHttpShutdown = (
  program: Effect.Effect<unknown, unknown>,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 300_000
    ) {
      return yield* Effect.fail(
        new Error(
          "ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS must be a positive integer at most 300000",
        ),
      );
    }

    const signal = yield* Deferred.make<void>();
    const scope = yield* Scope.make("parallel");
    const dependencies = yield* Scope.make();
    const servers = new Set<Server>();
    let stopping = false;
    let drained = false;
    let timedOut = false;
    const runnerFailures: Cause.Cause<unknown>[] = [];
    const requestFailures: Cause.Cause<unknown>[] = [];
    const requests = new Set<Fiber.Fiber<unknown, unknown>>();
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // Leave time for request/instance finalizers, then for Fly's own stop deadline.
    const drainTimeoutMs = Math.floor(timeoutMs * 0.8);
    const exitTimeoutMs = Math.min(Math.floor(timeoutMs * 0.9), 2 ** 31 - 1);

    // Native timers remain independent of uninterruptible Effect finalizers.
    const beginShutdown = () => {
      if (stopping) return;
      stopping = true;
      drainDeadline = setTimeout(() => {
        if (drained) return;
        timedOut = true;
        console.error(
          "Managed HTTP drain deadline exceeded; closing connections.",
        );
        for (const server of servers) server.closeAllConnections();
      }, drainTimeoutMs);
      deadline = setTimeout(() => {
        console.error("Managed HTTP shutdown deadline exceeded; exiting.");
        process.exit(1);
      }, exitTimeoutMs);
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSignal = () => {
          beginShutdown();
          Deferred.doneUnsafe(signal, Effect.void);
        };
        process.on("SIGTERM", onSignal);
        process.on("SIGINT", onSignal);
        return onSignal;
      }),
      (onSignal) =>
        Effect.sync(() => {
          process.off("SIGTERM", onSignal);
          process.off("SIGINT", onSignal);
          if (drainDeadline !== undefined) clearTimeout(drainDeadline);
          if (deadline !== undefined) clearTimeout(deadline);
        }),
    );
    yield* Effect.addFinalizer((exit) => Scope.close(dependencies, exit));
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));

    const fiber = yield* program.pipe(
      Effect.provideService(ManagedHttpShutdown, {
        scope,
        dependencies,
        servers,
        drainTimeoutMs,
        isStopping: () => stopping,
        observeRequest: (request) => {
          if (requests.has(request)) return;
          requests.add(request);
          request.addObserver((exit) => {
            requests.delete(request);
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              requestFailures.push(exit.cause);
              console.error(
                "Managed HTTP request cleanup failed",
                Cause.pretty(exit.cause),
              );
            }
          });
        },
        runnerFinished: (exit, last) => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            runnerFailures.push(exit.cause);
            console.error(
              "Managed process cleanup failed",
              Cause.pretty(exit.cause),
            );
            beginShutdown();
            Deferred.doneUnsafe(signal, Effect.void);
          } else if (last) {
            beginShutdown();
          }
        },
      }),
      Effect.forkChild,
    );
    const interrupted = yield* Effect.raceFirst(
      Deferred.await(signal).pipe(Effect.as(true)),
      Fiber.await(fiber).pipe(Effect.as(false)),
    );
    yield* Effect.sync(beginShutdown);
    // Neither HTTP drain nor one worker's finalizers may delay another's stop.
    const [httpExit, programExit] = yield* Effect.all(
      [
        Scope.close(scope, Exit.void).pipe(Effect.exit),
        Effect.gen(function* () {
          if (interrupted) yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      ],
      { concurrency: "unbounded" },
    );
    // Socket closure is not completion of the request fiber's finalizers.
    yield* Fiber.awaitAll(requests);
    drained = true;
    const dependencyExit = yield* Scope.close(dependencies, programExit).pipe(
      Effect.exit,
    );
    const failures = runnerFailures.concat(
      requestFailures,
      [httpExit, programExit, dependencyExit].flatMap((exit) =>
        Exit.isFailure(exit) &&
        !(interrupted && Cause.hasInterruptsOnly(exit.cause))
          ? [exit.cause]
          : [],
      ),
    );
    for (const cause of failures) {
      yield* Effect.logError("Managed process cleanup failed", cause);
    }
    if (failures.length > 0) return yield* Effect.failCause(failures[0]!);
    if (timedOut) {
      return yield* Effect.fail(
        new Error("Managed process drain deadline exceeded"),
      );
    }
    return interrupted;
  }).pipe(Effect.scoped);
