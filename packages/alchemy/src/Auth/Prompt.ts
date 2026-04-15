import * as p from "@clack/prompts";
import * as Effect from "effect/Effect";

/**
 * Wraps a clack prompt (which returns a `Promise<T | symbol>` where the
 * symbol indicates user cancellation) in an Effect.
 *
 * Returns `undefined` if the user cancels (Ctrl+C / Escape).
 *
 * Uses `Effect.callback` so fiber interruption propagates via the abort
 * signal to any async resources we own; the clack prompt itself is left
 * to resolve — its result is ignored after interruption.
 */
export const prompt = <T>(
  fn: () => Promise<T | symbol>,
): Effect.Effect<T | undefined> =>
  Effect.callback<T | undefined>((resume, signal) => {
    let settled = false;
    fn().then(
      (result) => {
        if (settled || signal.aborted) return;
        settled = true;
        if (p.isCancel(result)) {
          resume(Effect.succeed(undefined));
        } else {
          resume(Effect.succeed(result as T));
        }
      },
      (err) => {
        if (settled || signal.aborted) return;
        settled = true;
        resume(Effect.die(err));
      },
    );
  });
