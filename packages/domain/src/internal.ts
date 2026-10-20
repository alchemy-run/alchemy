import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Scope } from "effect/Scope";

/**
 * Capture the services `R` for later use, minus the `Scope`: a captured
 * construction-time scope must never replace the scope of a later request or
 * event (finalizers would attach to the wrong lifetime, and on workerd the
 * work would be pinned to another request's I/O context).
 *
 * @internal
 */
export const captureContext = <R = never>(): Effect.Effect<
  Context.Context<Exclude<R, Scope>>,
  never,
  R
> =>
  Effect.map(
    Effect.context<R>(),
    (context) => Context.omit(Scope)(context) as Context.Context<Exclude<R, Scope>>,
  );
