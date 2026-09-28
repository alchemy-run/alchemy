import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import {
  callbackFailure,
  decodeApplicationFailure,
  type TerminalFailure,
  type WorkflowIdentity,
} from "./WorkflowFailure.ts";

/** Own native callbacks without waiting for native retry timers on interruption. */
export const runWorkflowTask = <A, E, C>(options: {
  readonly name: string;
  readonly identity?: WorkflowIdentity;
  readonly terminalFailure: TerminalFailure;
  readonly isNativeTerminal?: (error: unknown) => error is Error;
  readonly effect: (context: C) => Effect.Effect<A, E, Scope.Scope>;
  readonly native: (
    callback: (context: C) => Promise<A>,
    run: <B, F>(effect: Effect.Effect<B, F, Scope.Scope>) => Promise<B>,
  ) => Promise<A>;
}): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const runPromise = yield* FiberSet.makeRuntimePromise<never>();
      let failure: { message: string; cause: Cause.Cause<E> } | undefined;
      const run = async <B, F>(effect: Effect.Effect<B, F, Scope.Scope>) => {
        const exit = await runPromise(
          Effect.yieldNow.pipe(
            Effect.andThen(effect),
            Effect.scoped,
            Effect.exit,
          ),
        );
        if (Exit.isSuccess(exit)) return exit.value;
        throw await callbackFailure(
          exit.cause,
          options.terminalFailure,
          options.name,
          options.identity,
          options.isNativeTerminal,
        );
      };
      const callback = async (context: C) => {
        // Register the fiber before callback effects can interrupt their owner.
        const exit = await runPromise(
          Effect.yieldNow.pipe(
            Effect.andThen(Effect.suspend(() => options.effect(context))),
            Effect.scoped,
            Effect.exit,
          ),
        );
        if (Exit.isSuccess(exit)) return exit.value;
        const error = await callbackFailure(
          exit.cause,
          options.terminalFailure,
          options.name,
          options.identity,
          options.isNativeTerminal,
        );
        // Native persistence discards custom fields; only match this invocation's error.
        if (!Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)) {
          failure = { message: error.message, cause: exit.cause };
        }
        throw error;
      };
      return yield* Effect.tryPromise({
        try: () => options.native(callback, run),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          failure &&
          error instanceof Error &&
          error.name === "Error" &&
          error.message === failure.message
            ? Effect.failCause(failure.cause)
            : Effect.promise(() =>
                decodeApplicationFailure<E>(
                  error,
                  options.name,
                  options.identity,
                ),
              ).pipe(
                Effect.flatMap((cause) =>
                  cause ? Effect.failCause(cause) : Effect.die(error),
                ),
              ),
        ),
      );
    }),
  );

/** Close run resources with the original exit; cleanup cannot replace the result. */
export const withWorkflowScope = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  isEjected: (scope: Scope.Scope) => boolean = () => false,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const exit = yield* restore(
        effect.pipe(Effect.provideService(Scope.Scope, scope)),
      ).pipe(Effect.exit);
      if (!isEjected(scope)) {
        yield* Scope.close(scope, exit).pipe(
          Effect.ignoreCause({
            log: "Warn",
            message: "Workflow run scope close failed",
          }),
        );
      }
      return yield* exit;
    }),
  );
