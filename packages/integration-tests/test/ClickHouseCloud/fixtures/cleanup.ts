import * as Effect from "effect/Effect";

/**
 * Start a test from an empty stack and destroy the stack when the test's
 * scope closes, so a failing assertion still deletes what the test made
 * (and stops paying for it). Use inside `Effect.scoped`.
 */
export const cleanSlate = <E, R>(stack: { readonly destroy: () => Effect.Effect<unknown, E, R> }) =>
  Effect.acquireRelease(stack.destroy(), () => stack.destroy().pipe(Effect.ignore));
