import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";
import * as Runtime from "effect/Runtime";

import { AuthError } from "../../Auth/AuthProvider.ts";
import { recordCli } from "../../Telemetry/Metrics.ts";
import { TerminalCancelled } from "../../Cli/CliKit/index.ts";
// leaf imports (not the ui barrel): this module runs at CLI startup, before
// selectCli decides whether ink is needed at all
import {
  ANSI_DIM,
  ANSI_RESET,
  ansiFg,
  colorsEnabled,
  glyphsFor,
  theme,
  unicodeEnabled,
} from "../CliKit/index.ts";

export const USER = Config.string("USER").pipe(
  Config.orElse(() => Config.string("USERNAME")),
  Config.withDefault("unknown"),
);

export const STAGE = Config.string("STAGE").pipe(
  Config.option,
  (a) => a,
  Effect.map(Option.getOrUndefined),
);

/**
 * `true` if `e` is a {@link TerminalCancelled}, or an {@link AuthError} whose
 * `cause` chain bottoms out in one. Schema-tagged errors don't always
 * survive `instanceof` across module boundaries, so we also accept any
 * object whose `_tag` matches.
 */
export const isPromptCancellation = (e: unknown): boolean => {
  for (let cur: unknown = e, i = 0; cur != null && i < 16; i++) {
    if (cur instanceof TerminalCancelled) return true;
    if (
      typeof cur === "object" &&
      (cur as { _tag?: unknown })._tag === "TerminalCancelled"
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

/**
 * Conventional exit code for a user-cancelled run (128 + SIGINT), so scripts
 * and agents can distinguish "aborted" from both success and failure.
 */
export const EXIT_CANCELLED = 130;

/**
 * Mark the run as declined/aborted by the user without dumping a cause.
 * Any message has already been rendered by the prompt UI; the non-zero
 * exit code is what lets a script tell "declined" apart from "applied".
 */
export const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code;
  });

export const exitDeclined = setExitCode(1);

/**
 * During `alchemy dev` the outer command is only a supervisor — the exec
 * child owns the terminal and reports the shutdown. Without suppression a
 * Ctrl+C hits both processes and the user sees the interrupt message twice.
 */
let interruptMessagesSuppressed = false;
export const suppressInterruptMessages = Effect.sync(() => {
  interruptMessagesSuppressed = true;
});

/**
 * Catches user cancellations (Ctrl+C inside a prompt, surfaced as
 * {@link TerminalCancelled} or wrapped in an {@link AuthError}) and exits
 * the CLI cleanly with a friendly message instead of dumping a stack
 * trace. The process still exits {@link EXIT_CANCELLED} so scripts don't
 * mistake an aborted run for a completed one.
 */
export const handleCancellation = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchCause((cause) => {
      const cancelled = cause.reasons.some((r) => {
        if (Cause.isFailReason(r)) return isPromptCancellation(r.error);
        if (Cause.isDieReason(r)) return isPromptCancellation(r.defect);
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
    // A bare fiber interrupt shouldn't dump a stack trace either; the
    // runtime teardown reports interrupt-only causes as EXIT_CANCELLED on
    // its own. A SIGINT already announced "Shutting down…" above, so only
    // interrupts from other sources still print here.
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

/**
 * Wraps a cause that has already been printed to the user. The
 * `errorReported` marker tells the runtime's main runner to skip its own
 * cause dump; the process still exits non-zero.
 */
class ReportedCliError {
  readonly [Runtime.errorReported] = false;
  constructor(readonly cause: unknown) {}
}

/**
 * Errors whose `message` IS the user-facing diagnosis (missing or invalid
 * profile, unconfigured credentials, bad provider config): alchemy's own
 * auth errors plus distilled's `ConfigError`, which per-cloud credential
 * layers use to wrap profile/credential resolution failures (often via
 * `orDie`, so it can surface as a defect). Matched structurally by tag
 * because these arrive as `unknown` defects and schema-tagged errors don't
 * always survive `instanceof` across module boundaries.
 */
const isUserFacingError = S.is(
  S.Struct({
    _tag: S.Literals([
      "AuthError",
      "NeedsReauth",
      "ProfileError",
      "ConfigError",
      "NonInteractiveTerminal",
      "StackEntrypointError",
      "UserInputError",
    ]),
    message: S.String,
  }),
);

/**
 * An argument/flag value the user got wrong (bad `--since`, `stage` without
 * `stack`, ...). Rendered as a single `error:` line by
 * {@link handleUserErrors} instead of a cause dump.
 */
export class UserInputError extends Data.TaggedError("UserInputError")<{
  readonly message: string;
}> {}

/**
 * Prints auth/profile/config failures (nonexistent profile, unconfigured
 * credentials, invalid profile name, ...) as a single clean `error:` line
 * instead of a raw cause dump, and exits non-zero. Anything else propagates
 * unchanged. Apply *outside* {@link handleCancellation} so prompt
 * cancellations wrapped in {@link AuthError} are still handled as
 * cancellations first.
 */
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

/** Apply the complete user-facing CLI error boundary to an entrypoint. */
export const handleCliErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(handleCancellation, handleUserErrors);

/**
 * Print a command's help but exit non-zero. Used by TTY-only commands
 * (`alchemy profile`, `alchemy state`) invoked without a terminal: the help
 * text tells a human what to run instead, and the exit code tells a script
 * the invocation itself did nothing. A bare `ShowHelp` with no errors would
 * exit 0, indistinguishable from success.
 */
export const failWithHelp = (commandPath: ReadonlyArray<string>) =>
  setExitCode(1).pipe(
    Effect.andThen(
      Effect.fail(
        new CliError.ShowHelp({ commandPath: [...commandPath], errors: [] }),
      ),
    ),
  );

export const stage = Flag.string("stage").pipe(
  Flag.withSchema(S.String.check(S.isPattern(/^[a-z0-9]+([-_a-z0-9]+)*$/gi))),
  Flag.withDescription("Stage to deploy to, defaults to dev_${USER}"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
  Flag.mapEffect(
    Effect.fn(function* (stage) {
      if (stage) {
        return stage;
      }
      return yield* STAGE.pipe(
        Effect.catch(() =>
          Effect.fail(
            new CliError.MissingOption({
              option: "stage",
            }),
          ),
        ),
        Effect.flatMap((s) =>
          s === undefined
            ? USER.pipe(
                Effect.map((user) => `dev_${user}`),
                Effect.catch(() => Effect.succeed("unknown")),
              )
            : Effect.succeed(s),
        ),
      );
    }),
  ),
);

export const envFile = Flag.file("env-file").pipe(
  Flag.optional,
  Flag.withDescription(
    "File to load environment variables from, defaults to .env",
  ),
);

export const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Dry run the deployment, do not actually deploy"),
  Flag.withDefault(false),
);

export const yes = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Yes to all prompts"),
  Flag.withDefault(false),
);

export const force = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force updates for resources that would otherwise no-op",
  ),
  Flag.withDefault(false),
);

export const config = Flag.file("config", { mustExist: true }).pipe(
  Flag.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Flag.withAlias("c"),
  Flag.withDefault("alchemy.run.ts"),
);

export const profile = Flag.string("profile").pipe(
  Flag.withDescription(
    "Auth profile to use. Defaults to $ALCHEMY_PROFILE or 'default'.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

/**
 * Categorical ramp for distinguishing resource streams in `logs --follow`,
 * ordered so adjacent assignments get maximally distinct brand hues.
 */
export const TAIL_COLORS = [
  ansiFg(theme.color.accent), // lifted moss
  ansiFg(theme.color.info), // slate teal
  ansiFg(theme.color.danger), // terracotta
  ansiFg(theme.color.warning), // honey
  ansiFg(theme.color.accentBright), // lit leaves
  ansiFg(theme.color.danger), // brick
  ansiFg(theme.color.muted), // warm umber
  ansiFg(theme.color.accentMuted), // sage
  ansiFg(theme.color.success), // moss
];

export const formatLocalTimestamp = (date: Date): string => {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const tz =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms} ${tz}`;
};

export const parseSince = (value: string) =>
  Effect.gen(function* () {
    const match = value.match(/^(\d+)([smhd])$/);
    if (match) {
      const amount = match[1];
      const unit = match[2];
      if (amount === undefined || unit === undefined) {
        return yield* new UserInputError({
          message: `Invalid --since value: '${value}'.`,
        });
      }
      const num = parseInt(amount, 10);
      const duration =
        unit === "s"
          ? Duration.seconds(num)
          : unit === "m"
            ? Duration.minutes(num)
            : unit === "h"
              ? Duration.hours(num)
              : Duration.days(num);
      const now = yield* Clock.currentTimeMillis;
      return new Date(now - Duration.toMillis(duration));
    }
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) {
      return yield* new UserInputError({
        message: `Invalid --since value: '${value}'. Use a duration (e.g. '1h', '30m') or ISO date.`,
      });
    }
    return parsed;
  });

/**
 * Wraps a CLI command handler with a top-level OpenTelemetry span
 * (`cli.<command>`) and bumps the `alchemy.cli.invocations` counter.
 *
 * `attrs` runs against the parsed command args and contributes
 * additional attributes to the span (e.g. stage, profile, dry-run flag).
 *
 * Usage:
 * ```ts
 * Command.make(
 *   "deploy",
 *   { ...flags },
 *   instrumentCommand("deploy", (a) => ({
 *     "alchemy.stage": a.stage,
 *     "alchemy.profile": a.profile,
 *   }))(execStack),
 * );
 * ```
 */
export const instrumentCommand =
  <AttrsArgs = unknown>(
    command: string,
    attrs?: (args: AttrsArgs) => Record<string, unknown>,
  ) =>
  <Args extends AttrsArgs, A, E, R>(
    handler: (args: Args) => Effect.Effect<A, E, R>,
  ): ((args: Args) => Effect.Effect<A, E, R>) =>
  (args) =>
    handler(args).pipe(
      Effect.withSpan(`cli.${command}`, {
        attributes: attrs ? attrs(args) : {},
      }),
      recordCli(command),
    );

/** Lazy profile UI import so React/Sigil stay off the CLI startup path. */
export const profileTui = Effect.promise(() => import("../views/Profile.tsx"));
