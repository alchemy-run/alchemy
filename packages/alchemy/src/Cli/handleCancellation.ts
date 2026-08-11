import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { AuthError } from "../Auth/AuthProvider.ts";
import { PromptCancelled } from "../Util/Clank.ts";

/**
 * `true` when an error is a cancelled prompt, including one wrapped by an
 * auth provider. Kept outside the shared command module so the CLI bootstrap
 * does not load every command helper before it knows which command will run.
 */
const isPromptCancellation = (e: unknown): boolean => {
  for (let cur: unknown = e, i = 0; cur != null && i < 16; i++) {
    if (cur instanceof PromptCancelled) return true;
    if (
      typeof cur === "object" &&
      (cur as { _tag?: unknown })._tag === "PromptCancelled"
    ) {
      return true;
    }
    if (
      cur instanceof AuthError ||
      (typeof cur === "object" &&
        (cur as { _tag?: unknown })._tag === "AuthError")
    ) {
      cur = (cur as { cause?: unknown }).cause;
      continue;
    }
    return false;
  }
  return false;
};

export const handleCancellation = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchCause((cause) => {
      const cancelled = cause.reasons.some((reason) => {
        if (Cause.isFailReason(reason)) {
          return isPromptCancellation(reason.error);
        }
        if (Cause.isDieReason(reason)) {
          return isPromptCancellation(reason.defect);
        }
        return false;
      });
      return cancelled
        ? Console.log("\nCancelled.")
        : (Effect.failCause(cause) as Effect.Effect<never, E, never>);
    }),
    Effect.onInterrupt(() => Console.log("\nInterrupted.")),
  );
