import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  AuthorizationFailed,
  ControlConflict,
  type ControlError,
  ControlInternalError,
  ControlNotFound,
  CredentialsRequired,
  InvalidControlInput,
  StaleRevision,
} from "./Surface.ts";

const isControlError = (error: unknown): error is ControlError =>
  [
    "InvalidControlInput",
    "ControlNotFound",
    "ControlConflict",
    "StaleRevision",
    "ControlCredentialsRequired",
    "ControlAuthorizationFailed",
    "ControlInternalError",
    "ProviderFailure",
  ].some((tag) => Predicate.isTagged(tag)(error));

/** Preserve control failures and interruption while translating implementation failures. */
export const internalize = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ControlError, R> =>
  effect.pipe(
    Effect.catchCause((cause): Effect.Effect<never, ControlError> => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;

      const failure = Cause.findErrorOption(cause);
      if (Option.isSome(failure)) {
        const error = failure.value;
        if (isControlError(error)) {
          return Effect.fail(error);
        }
      }

      return Effect.fail(
        new ControlInternalError({
          message: "Unexpected failure in Alchemy control operation.",
          cause,
        }),
      );
    }),
  );
