import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import * as Effect from "effect/Effect";
import { PiError } from "../Errors.ts";

/** Pi's error text, whatever was thrown. */
export const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

/**
 * Run a Pi call that takes a Chord `Context`. Interrupting the fiber aborts
 * the context, which cancels only Pi's wait, never its durable work.
 */
export const fromPi = <A>(call: (context: Context) => Promise<A>): Effect.Effect<A, PiError> =>
  Effect.tryPromise({
    try: (signal) => call(withAbortSignal(signal, BACKGROUND_CONTEXT)),
    catch: (cause) => new PiError({ message: messageOf(cause), cause }),
  });

/** Run a synchronous Pi call that may throw. */
export const fromPiSync = <A>(call: () => A): Effect.Effect<A, PiError> =>
  Effect.try({
    try: call,
    catch: (cause) => new PiError({ message: messageOf(cause), cause }),
  });
