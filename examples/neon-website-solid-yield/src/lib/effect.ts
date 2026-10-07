import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Result from "effect/Result";
import { attempt } from "solid-yield";

// Carries a failed Exit's Cause out of the promise, so the handler below can
// tell the Effect's typed failure apart from a defect.
class EffectFailed {
  constructor(readonly cause: Cause.Cause<unknown>) {}
}

/**
 * Run an Effect on `runtime` inside a solid-yield routine (a `$memo` or an
 * `$event`). The runtime provides the Effect's services.
 *
 * The routine is pending while the fiber runs. The Effect's typed failure `E`
 * becomes the routine's failure color as-is, so make `E` a solid-yield
 * `Failure` and an `Errored({ catch: [E] })` handles it. A defect is mapped
 * through `onDefect`.
 */
export const runEffect = <A, E extends Error, D extends Error, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  effect: Effect.Effect<A, E, R>,
  onDefect: (defect: unknown) => D,
): ReturnType<typeof attempt<Promise<A>, E | D>> =>
  attempt<Promise<A>, E | D>(
    () =>
      runtime.runPromiseExit(effect).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        throw new EffectFailed(exit.cause);
      }),
    // solid-yield checks a handler's failure kinds per concrete type; `E` and
    // `D` are checked where `runEffect` is called instead.
    ((caught: unknown): E | D =>
      caught instanceof EffectFailed
        ? Result.match(Cause.findError(caught.cause as Cause.Cause<E>), {
            onSuccess: (error) => error,
            onFailure: () => onDefect(Cause.squash(caught.cause)),
          })
        : onDefect(caught)) as never,
  );
