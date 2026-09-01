import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Runtime from "effect/Runtime";
import * as CliError from "effect/unstable/cli/CliError";
import { isUserFacing, UserFacingError } from "../../UserFacingError.ts";
import {
  ANSI_DIM,
  ANSI_RESET,
  ansiFg,
  colorsEnabled,
  glyphsFor,
  spinnerFramesFor,
  theme,
  unicodeEnabled,
} from "../CliKit/index.ts";

const isTerminalCancelled = Schema.is(
  Schema.Struct({ _tag: Schema.Literals(["TerminalCancelled"]) }),
);
const isAuthErrorLike = Schema.is(
  Schema.Struct({
    _tag: Schema.Literals(["AuthError"]),
    cause: Schema.optional(Schema.Unknown),
  }),
);

export const isPromptCancellation = (error: unknown): boolean => {
  for (let current = error, depth = 0; current != null && depth < 16; depth++) {
    if (isTerminalCancelled(current)) return true;
    if (!isAuthErrorLike(current)) return false;
    current = current.cause;
  }
  return false;
};

export const EXIT_CANCELLED = 130;

export const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code;
  });

export const exitDeclined = setExitCode(1);

let interruptMessagesSuppressed = false;
export const suppressInterruptMessages = Effect.sync(() => {
  interruptMessagesSuppressed = true;
});

const SHUTDOWN_FEEDBACK_DELAY_MS = 200;

/**
 * Shutdown feedback on SIGINT/SIGTERM: silent when teardown finishes within
 * 200ms, otherwise a spinner (TTY) or periodic log lines (plain). A second
 * signal force-quits. Raw stderr + unref'd timers on purpose — the Effect
 * runtime (and any `Runtime.Teardown` hook) only settles after finalizers,
 * which is exactly the window this has to render through.
 */
export const installShutdownFeedback = Effect.sync(() => {
  let received = false;
  const onSignal = () => {
    if (received) {
      if (!interruptMessagesSuppressed) {
        process.stderr.write("\nForce quitting.\n");
      }
      process.exit(EXIT_CANCELLED);
    }
    received = true;
    if (interruptMessagesSuppressed) return;
    const startedAt = Date.now();
    const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
    const timer = setTimeout(() => {
      if (process.stderr.isTTY) {
        const frames = spinnerFramesFor(unicodeEnabled());
        let frame = 0;
        const spin = setInterval(() => {
          process.stderr.write(
            `\r${frames[frame++ % frames.length]} Shutting down... (Ctrl+C again to force quit) `,
          );
        }, 80);
        spin.unref();
      } else {
        process.stderr.write(
          "Shutting down — waiting for cleanup to finish (Ctrl+C again to force quit)\n",
        );
        const report = setInterval(() => {
          process.stderr.write(`Still shutting down (${elapsed()}s)\n`);
        }, 5000);
        report.unref();
      }
    }, SHUTDOWN_FEEDBACK_DELAY_MS);
    timer.unref();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
});

export const handleCancellation = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchCause((cause) => {
      const cancelled = cause.reasons.some((reason) => {
        if (Cause.isFailReason(reason))
          return isPromptCancellation(reason.error);
        if (Cause.isDieReason(reason))
          return isPromptCancellation(reason.defect);
        return false;
      });
      return cancelled
        ? Console.log(
            colorsEnabled()
              ? `\n${ANSI_DIM}Cancelled.${ANSI_RESET}`
              : "\nCancelled.",
          ).pipe(Effect.andThen(setExitCode(EXIT_CANCELLED)))
        : (Effect.failCause(cause) as Effect.Effect<never, E, never>);
    }),
    Effect.onInterrupt(() =>
      interruptMessagesSuppressed
        ? Effect.void
        : Console.log(
            colorsEnabled()
              ? `\n${ANSI_DIM}Interrupted.${ANSI_RESET}`
              : "\nInterrupted.",
          ),
    ),
  );

class ReportedCliError {
  readonly [Runtime.errorReported] = false;
  constructor(readonly cause: unknown) {}
}

// `ConfigError` is effect's own class and cannot carry the `UserFacingError`
// marker. Everything else is matched by the marker alone — new user-facing
// errors opt in by assigning the symbol, not by growing this list.
const isUnmarkedUserFacingError = Schema.is(
  Schema.Struct({
    _tag: Schema.Literals(["ConfigError"]),
    message: Schema.String,
  }),
);

const isUserFacingError = (
  error: unknown,
): error is { readonly message: string } =>
  isUserFacing(error) || isUnmarkedUserFacingError(error);

export class UserInputError extends Data.TaggedError("UserInputError")<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export const handleUserErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchCause((cause) => {
      for (const reason of cause.reasons) {
        const error = Cause.isFailReason(reason)
          ? reason.error
          : Cause.isDieReason(reason)
            ? reason.defect
            : undefined;
        if (isUserFacingError(error)) {
          const glyphs = glyphsFor(unicodeEnabled());
          return Console.error(
            `${colorsEnabled() ? `${ansiFg(theme.color.danger)}${glyphs.error} error:${ANSI_RESET}` : "error:"} ${error.message}`,
          ).pipe(
            Effect.flatMap(() => Effect.fail(new ReportedCliError(cause))),
          ) as Effect.Effect<never, E | ReportedCliError, never>;
        }
      }
      return Effect.failCause(cause) as Effect.Effect<never, E, never>;
    }),
  );

export const handleCliErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(handleCancellation, handleUserErrors);

export const failWithHelp = (commandPath: ReadonlyArray<string>) =>
  setExitCode(1).pipe(
    Effect.andThen(
      Effect.fail(
        new CliError.ShowHelp({ commandPath: [...commandPath], errors: [] }),
      ),
    ),
  );
