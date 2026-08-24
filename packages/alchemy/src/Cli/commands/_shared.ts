import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";
import { pathToFileURL } from "node:url";
import * as Runtime from "effect/Runtime";

import {
  type AuthProvider,
  AuthError,
  AuthProviders,
} from "../../Auth/AuthProvider.ts";
import { type Profile, withProfileOverride } from "../../Auth/Profile.ts";
import { AwsAuth } from "../../AWS/AuthProvider.ts";
import { AxiomAuth } from "../../Axiom/AuthProvider.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import { GitHubAuth } from "../../GitHub/AuthProvider.ts";
import { HetznerAuth } from "../../Hetzner/AuthProvider.ts";
import { NeonAuth } from "../../Neon/AuthProvider.ts";
import { PlanetscaleAuth } from "../../Planetscale/AuthProvider.ts";
import { PrismaAuth } from "../../Prisma/AuthProvider.ts";
import * as Stack from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { recordCli } from "../../Telemetry/Metrics.ts";
import { TerminalCancelled } from "../../Cli/CliKit/index.ts";
import { CliKit } from "../CliKit/CliKit.ts";
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
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

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
      // "PromptCancelled" is the legacy Clack (Util/Clank.ts) cancellation;
      // it goes away once every command has migrated to CliKit prompts.
      ((cur as { _tag?: unknown })._tag === "TerminalCancelled" ||
        (cur as { _tag?: unknown })._tag === "PromptCancelled")
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
export const exitDeclined = Effect.sync(() => {
  process.exitCode = 1;
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
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = EXIT_CANCELLED;
              }),
            ),
          )
        : (Effect.failCause(cause) as Effect.Effect<never, E, never>);
    }),
    // A bare fiber interrupt (Ctrl+C while not inside a prompt) shouldn't
    // dump a stack trace either; the runtime teardown reports interrupt-only
    // causes as EXIT_CANCELLED on its own.
    Effect.onInterrupt(() =>
      Console.log(
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
  Effect.sync(() => {
    // The runtime teardown prefers a non-zero `process.exitCode` when the
    // effect's own exit code is 0 (which is what an errorless ShowHelp
    // reports).
    process.exitCode = 1;
  }).pipe(
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

export const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Dry run the deployment, do not actually deploy"),
  Flag.withDefault(false),
);

export const script = Argument.file("main", {
  mustExist: true,
}).pipe(
  Argument.withDescription("Main file to deploy, defaults to alchemy.run.ts"),
  Argument.withDefault("alchemy.run.ts"),
);

export const resourceFilter = Flag.string("filter").pipe(
  Flag.withDescription(
    "Comma-separated logical resource IDs (e.g. Api,Sandbox). Only those resources are included.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const parseResourceFilter = (
  filter: string | undefined,
): ReadonlySet<string> | undefined => {
  if (filter === undefined) return undefined;
  const ids = filter
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return undefined;
  return new Set(ids);
};

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
export const TAIL_RESET = ANSI_RESET;

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

export const parseSince = (value: string): Date => {
  const match = value.match(/^(\d+)([smhd])$/);
  if (match) {
    const num = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const ms =
      unit === "s"
        ? num * 1000
        : unit === "m"
          ? num * 60_000
          : unit === "h"
            ? num * 3_600_000
            : num * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    throw new UserInputError({
      message: `Invalid --since value: '${value}'. Use a duration (e.g. '1h', '30m') or ISO date.`,
    });
  }
  return parsed;
};

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

/**
 * Lazy accessor for the ink-based profile TUI components, shared by every
 * render site so react/ink stay off the CLI startup path.
 */
export const profileTui = Effect.promise(() => import("../views/Profile.tsx"));

/**
 * Resolve a profile's stored credential entries into display records —
 * provider name, method, live status, and detail lines. Providers return
 * structured {@link ProviderDetails}; a {@link NeedsReauth} failure renders
 * as "needs re-login" while anything else (including defects from
 * `Effect.orDie` resolve paths) renders as an error line, so one broken
 * provider can't abort rendering the rest of the profile.
 */
export const resolveProfileDisplay = Effect.fn(function* (
  profile: string,
  stored: Profile["providers"],
  registry: AuthProviders["Service"],
) {
  const detailsTimeout = Duration.seconds(15);
  const renderProvider = (name: string) =>
    Effect.gen(function* () {
      const cfg = stored[name]!;
      const provider: AuthProvider | undefined = registry[name];
      if (provider == null) {
        const { method: _method, ...rest } = cfg as Record<string, unknown> & {
          method: string;
        };
        return {
          name,
          method: cfg.method,
          status: "configured" as const,
          lines: Object.entries(rest).map(
            ([k, v]) =>
              `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
          ),
        };
      }

      // Decode the raw manifest entry first: a hand-edited or version-skewed
      // entry renders as an error line with the reconfigure hint instead of
      // reaching provider code that matches exhaustively on `method`.
      return yield* provider
        .decodeConfig(profile, cfg)
        .pipe(Effect.flatMap((decoded) => provider.details(profile, decoded)))
        .pipe(
          // Credential helpers may invoke an external process or local
          // container. A broken helper must not hold the whole profile UI
          // hostage: resolving each provider independently also leaves the
          // edit/remove path available for the bad entry.
          Effect.timeout(detailsTimeout),
          Effect.map((details) => ({
            name,
            method: cfg.method,
            status: "ready" as const,
            lines: details.lines
              // Providers include `source` unconditionally; drop it when it
              // just restates the configured method.
              .filter(
                (line) => !(line.key === "source" && line.value === cfg.method),
              )
              .map((line) => `${line.key}: ${line.value}`),
          })),
          Effect.catchTag("NeedsReauth", (e) =>
            Effect.succeed({
              name,
              method: cfg.method,
              status: "reauth" as const,
              lines: [e.message],
            }),
          ),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            const message =
              typeof error === "object" &&
              error !== null &&
              "_tag" in error &&
              error._tag === "TimeoutError"
                ? "Timed out after 15 seconds. Reconfigure or remove this provider."
                : error instanceof Error
                  ? error.message
                  : String(error);
            return Effect.succeed({
              name,
              method: cfg.method,
              status: "error" as const,
              lines: [`Failed to retrieve credentials: ${message}`],
            });
          }),
        );
    });

  // `details` is read-only but resolves live credentials (SSO, OAuth
  // refresh, whoami calls) — render providers concurrently so wall time is
  // the slowest provider, not the sum.
  return yield* Effect.forEach(Object.keys(stored).sort(), renderProvider, {
    concurrency: 4,
  });
});

/**
 * Render a profile's stored credential entries in the branded transcript
 * style (`▽` section + `│` gutter, yantra palette) across
 * `alchemy profile edit`, `alchemy profile show`, and the interactive hub.
 */
export const printProfile = Effect.fn(function* (
  profile: string,
  stored: Profile["providers"],
  registry: AuthProviders["Service"],
  active = true,
) {
  const providers = yield* resolveProfileDisplay(profile, stored, registry);
  const cli = yield* CliKit;
  if (!cli.terminal.input) {
    const lines = [`Profile ${profile}${active ? " (active)" : ""}`];
    if (providers.length === 0) lines.push("No providers configured.");
    for (const provider of providers) {
      const status =
        provider.status === "reauth" ? "needs re-login" : provider.status;
      lines.push(`${provider.name} (${provider.method}): ${status}`);
      lines.push(...provider.lines.map((line) => `  ${line}`));
    }
    return yield* Console.log(lines.join("\n"));
  }
  const { profileDetailsNode } = yield* profileTui;
  yield* cli.output.print(profileDetailsNode(profile, providers, active));
});

export class StackEntrypointError extends Data.TaggedError(
  "StackEntrypointError",
)<{
  readonly message: string;
}> {}

export const importStack = Effect.fn(function* (main: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.resolve(main);
  if (!(yield* fs.exists(absolutePath))) {
    return yield* Effect.fail(
      new StackEntrypointError({
        message: `Stack entrypoint '${main}' does not exist in '${path.dirname(absolutePath)}'. Run this command from an Alchemy project or pass --config <path>.`,
      }),
    );
  }
  // Build a `file://` URL from the absolute path. `import.meta.resolve` expects a
  // module specifier / URL, not a raw filesystem path: on Windows an absolute
  // path like `D:\stack.ts` is not a valid specifier and fails to resolve, so the
  // CLI cannot load the user's stack. `pathToFileURL` produces a valid URL on
  // every platform.
  const url = pathToFileURL(absolutePath).href;
  const module = yield* Effect.promise(() => import(url));
  const stackEffect = module.default as ReturnType<
    ReturnType<typeof Stack.make>
  >;
  if (!Effect.isEffect(stackEffect)) {
    return yield* Effect.fail(
      new StackEntrypointError({
        message: `Stack entrypoint '${main}' must export a default stack definition (export default Alchemy.Stack({...})).`,
      }),
    );
  }
  return stackEffect as typeof stackEffect & {
    stackName: string;
    stage: string;
    providers: Layer.Layer<never>;
    state: Layer.Layer<never>;
  };
});

/**
 * Placeholder {@link Stack.Stack} value used while building a stack's
 * `providers()` layer out of band. No real resources exist yet — we only
 * want the layer's provider/auth registrations and cloud-environment
 * services, so `resources`/`bindings`/`actions` are empty and the stage is a
 * sentinel.
 */
const placeholderStack = (name: string) => ({
  actions: {},
  bindings: {},
  name,
  resources: {},
  stage: "placeholder",
});

export interface BuildStackProvidersOptions {
  /** Stack entrypoint to import (e.g. `"alchemy.run.ts"`). */
  main: string;
  envFile: Option.Option<string>;
  /** `--profile` override; `undefined` falls through to the stored default. */
  profile: string | undefined;
  /**
   * Registry to populate. Pass a pre-seeded registry (e.g. one that already
   * has built-in providers) to layer the stack's providers on top of it,
   * overriding by name. Defaults to a fresh empty registry.
   */
  registry?: AuthProviders["Service"];
  /**
   * Logger layer used during the build. Defaults to the file logger
   * (`out`). `alchemy unsafe nuke` overrides this to log to the console in
   * debug mode.
   */
  logger?: Layer.Layer<never, never, never>;
  /**
   * Extra layer merged into the placeholder scaffold — e.g.
   * `Layer.succeed(MinimumLogLevel, ...)`, which sets a fiber-ref default
   * and so contributes no context service (`Layer<never>`).
   */
  extra?: Layer.Layer<never, never, never>;
}

/**
 * Import a stack entrypoint and build its `providers()` (+ `state()`) layer
 * out of band against placeholder {@link Stack.Stack}/{@link Stage} services,
 * so its `AuthProviderLayer` registrations land in an {@link AuthProviders}
 * registry and the built context holds every resource provider plus the
 * cloud-environment services their operations need.
 *
 * Shared by profile commands and `alchemy unsafe nuke`. The caller decides
 * what to do with the result — use `authProviders` or the built `context` —
 * and whether a missing conventional entrypoint should be skipped before
 * calling this function.
 */
export const buildStackProviders = Effect.fn("buildStackProviders")(function* (
  options: BuildStackProvidersOptions,
) {
  const authProviders = options.registry ?? {};
  const stackEffect = yield* importStack(options.main);
  const configProvider = withProfileOverride(
    yield* loadConfigProvider(options.envFile),
    options.profile,
  );
  const context = yield* Layer.build(
    (stackEffect.providers ?? Layer.empty).pipe(
      Layer.provideMerge(stackEffect.state ?? Layer.empty),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, authProviders),
          ConfigProvider.layer(configProvider),
          options.logger ??
            Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
          Layer.succeed(Stage, "placeholder"),
          Layer.succeed(Stack.Stack, placeholderStack(stackEffect.stackName)),
          options.extra ?? Layer.empty,
        ),
      ),
    ),
  );
  return { authProviders, context, stackEffect };
});

/**
 * The auth providers Alchemy ships with. Used as the baseline registry so
 * `alchemy profile edit` works from any folder (no `alchemy.run.ts` required) and
 * `alchemy profile show` can pretty-print any provider a profile mentions,
 * even one the current stack doesn't wire up.
 */
export const builtinAuth = Layer.mergeAll(
  AwsAuth,
  AxiomAuth,
  CloudflareAuth,
  GitHubAuth,
  HetznerAuth,
  NeonAuth,
  PlanetscaleAuth,
  PrismaAuth,
);

/**
 * Build {@link builtinAuth} against `registry` so every built-in auth
 * provider registers itself, without importing any stack entrypoint.
 */
export const buildBuiltinAuthProviders = Effect.fn("buildBuiltinAuthProviders")(
  function* (options: {
    envFile: Option.Option<string>;
    profile: string;
    /** Registry to populate. Defaults to a fresh empty registry. */
    registry?: AuthProviders["Service"];
  }) {
    const authProviders = options.registry ?? {};
    yield* Layer.build(
      Layer.provide(
        builtinAuth,
        Layer.mergeAll(
          Layer.succeed(AuthProviders, authProviders),
          ConfigProvider.layer(
            withProfileOverride(
              yield* loadConfigProvider(options.envFile),
              options.profile,
            ),
          ),
          Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        ),
      ),
    );
    return authProviders;
  },
);
