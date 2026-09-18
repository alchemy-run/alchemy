import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { Server } from "node:http";

/** Internal lifetime for managed Node HTTP servers, separate from application fibers. */
export class ManagedHttpShutdown extends Context.Service<
  ManagedHttpShutdown,
  {
    readonly scope: Scope.Closeable;
    readonly servers: Set<Server>;
    readonly drainTimeoutMs: number;
    readonly isStopping: () => boolean;
  }
>()("Alchemy.Runtime.ManagedHttpShutdown") {}

export const withManagedHttpShutdown = (
  program: Effect.Effect<unknown, unknown>,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return yield* Effect.fail(
        new Error("ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS must be a positive integer"),
      );
    }

    const signal = yield* Deferred.make<void>();
    const scope = yield* Scope.make("parallel");
    const servers = new Set<Server>();
    let stopping = false;
    let drained = false;
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // Leave time for request/instance finalizers, then for Fly's own stop deadline.
    const drainTimeoutMs = Math.floor(timeoutMs * 0.8);
    const exitTimeoutMs = Math.min(Math.floor(timeoutMs * 0.9), 2 ** 31 - 1);

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSignal = () => {
          if (stopping) return;
          stopping = true;
          drainDeadline = setTimeout(
            () => {
              if (drained) return;
              console.error(
                "Managed HTTP drain deadline exceeded; closing connections.",
              );
              // server.close() alone never forcibly ends active HTTP connections.
              for (const server of servers) server.closeAllConnections();
            },
            Math.min(drainTimeoutMs, 2 ** 31 - 1),
          );
          deadline = setTimeout(() => {
            console.error("Managed HTTP shutdown deadline exceeded; exiting.");
            process.exit(1);
          }, exitTimeoutMs);
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
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));

    const fiber = yield* program.pipe(
      Effect.provideService(ManagedHttpShutdown, {
        scope,
        servers,
        drainTimeoutMs,
        isStopping: () => stopping,
      }),
      Effect.forkChild,
    );
    const interrupted = yield* Effect.raceFirst(
      Deferred.await(signal).pipe(Effect.as(true)),
      Fiber.join(fiber).pipe(Effect.as(false)),
    );
    if (interrupted) {
      // Node's preemptive shutdown drains responses before closing request scopes.
      yield* Scope.close(scope, Exit.void);
      drained = true;
      yield* Fiber.interrupt(fiber);
    }
    return interrupted;
  }).pipe(Effect.scoped);
