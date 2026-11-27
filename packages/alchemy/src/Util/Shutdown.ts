import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

/**
 * Time this process's shutdown in the run log: a Debug record when SIGINT or
 * SIGTERM arrives, and one when `effect` has finished (finalizers included),
 * with the time since the signal. Silent when the process ends on its own.
 */
export const logShutdown =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const clock = yield* Clock.Clock;
      let signalled: { readonly signal: string; readonly at: number } | undefined;
      const onSignal = (signal: NodeJS.Signals) => {
        if (signalled !== undefined) return;
        signalled = { signal, at: clock.currentTimeMillisUnsafe() };
        Effect.runForkWith(context)(Effect.logDebug(`shutdown: ${name} received ${signal}`));
      };
      // Ahead of the runtime's own handler, which interrupts this fiber and
      // can run its whole teardown synchronously before later listeners.
      process.prependListener("SIGINT", onSignal);
      process.prependListener("SIGTERM", onSignal);
      return yield* effect.pipe(
        Effect.onExit(() =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            return signalled === undefined
              ? Effect.void
              : Effect.logDebug(
                  `shutdown: ${name} finished ${now - signalled.at}ms after ${signalled.signal}`,
                );
          }),
        ),
      );
    });

/** Run `effect` and log how long it took, as a step of a shutdown. */
export const timedShutdownStep =
  (step: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Clock.currentTimeMillis, (start) =>
      effect.pipe(
        Effect.onExit(() =>
          Effect.flatMap(Clock.currentTimeMillis, (end) =>
            Effect.logDebug(`shutdown: ${step} in ${end - start}ms`),
          ),
        ),
      ),
    );

/**
 * Keep a child process alive through its parent's death long enough to shut
 * down. Its stdout and stderr are pipes the parent read: once the parent is
 * gone, the next write fails with EPIPE, which Node raises as an uncaught
 * exception and exits before any finalizer runs (workerd and dev servers
 * would outlive it). Other stream errors still throw.
 */
export const ignoreClosedStdio = Effect.sync(() => {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
});

/** The pid of the process that spawned this one, set by `alchemy dev`. */
export const PARENT_PID_ENV = "ALCHEMY_DEV_PARENT_PID";

/**
 * Completes once this process's parent is gone: it was reparented, so its
 * parent pid changed. Race the process's work against it to shut down with
 * finalizers when the parent is SIGKILLed, which no handler can see. The
 * parent's pid comes from {@link PARENT_PID_ENV} when set, so a parent that
 * died before this check started is caught too.
 */
export const parentExited = Effect.gen(function* () {
  const declared = yield* Config.option(Config.Number(PARENT_PID_ENV)).pipe(
    Effect.orElseSucceed(() => Option.none<number>()),
  );
  const parent = Option.isSome(declared) ? declared.value : yield* Effect.sync(() => process.ppid);
  yield* Effect.sync(() => process.ppid).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (current) => current !== parent,
    }),
  );
});
