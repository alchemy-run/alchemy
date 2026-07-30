import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";
import { pathToFileURL } from "node:url";
import { format, styleText } from "node:util";
import * as Runtime from "effect/Runtime";

import {
  type AuthProvider,
  AuthError,
  AuthProviders,
} from "../../Auth/AuthProvider.ts";
import {
  type Profile,
  ProfileStore,
  withProfileOverride,
} from "../../Auth/Profile.ts";
import { AwsAuth } from "../../AWS/AuthProvider.ts";
import { AxiomAuth } from "../../Axiom/AuthProvider.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import { GitHubAuth } from "../../GitHub/AuthProvider.ts";
import { NeonAuth } from "../../Neon/AuthProvider.ts";
import { PlanetscaleAuth } from "../../Planetscale/AuthProvider.ts";
import { PrismaAuth } from "../../Prisma/AuthProvider.ts";
import * as Stack from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { recordCli } from "../../Telemetry/Metrics.ts";
import { PromptCancelled } from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

export const USER = Config.string("USER").pipe(
  Config.orElse(() => Config.string("USERNAME")),
  Config.withDefault("unknown"),
);

export const STAGE = Config.string("stage").pipe(
  Config.option,
  (a) => a,
  Effect.map(Option.getOrUndefined),
);

/**
 * `true` if `e` is a {@link PromptCancelled}, or an {@link AuthError} whose
 * `cause` chain bottoms out in one. Schema-tagged errors don't always
 * survive `instanceof` across module boundaries, so we also accept any
 * object whose `_tag` matches.
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

/**
 * Catches user cancellations (Ctrl+C inside a prompt, surfaced as
 * {@link PromptCancelled} or wrapped in an {@link AuthError}) and exits
 * the CLI cleanly with a friendly message instead of dumping a stack
 * trace.
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
        ? Console.log("\nCancelled.")
        : (Effect.failCause(cause) as Effect.Effect<never, E, never>);
    }),
    // A bare fiber interrupt (Ctrl+C while not inside a prompt) shouldn't
    // dump a stack trace either.
    Effect.onInterrupt(() => Console.log("\nInterrupted.")),
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
    _tag: S.Literals(["AuthError", "ProfileError", "ConfigError"]),
    message: S.String,
  }),
);

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
          return Console.error(
            `${styleText("red", "error:")} ${error.message}`,
          ).pipe(
            Effect.flatMap(() => Effect.fail(new ReportedCliError(cause))),
          ) as Effect.Effect<never, E | ReportedCliError, never>;
        }
      }
      return Effect.failCause(cause) as Effect.Effect<never, E, never>;
    }),
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

export const script = Argument.file("main", {
  mustExist: true,
}).pipe(
  Argument.withDescription("Main file to deploy, defaults to alchemy.run.ts"),
  Argument.withDefault("alchemy.run.ts"),
);

export const profile = Flag.string("profile").pipe(
  Flag.withDescription(
    "Auth profile to use. Defaults to $ALCHEMY_PROFILE, the stored default, or 'default'.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

/**
 * Resolve the selected Alchemy profile after the command's dotenv provider is
 * known. Keeping the flag optional is important: otherwise the root CLI's
 * environment-only provider eagerly turns an omitted flag into `"default"`
 * and shadows `ALCHEMY_PROFILE` from `.env` / `--env-file`.
 */
export const resolveProfileSelection = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  const base = yield* loadConfigProvider(envFile);
  const profiles = yield* ProfileStore;
  const selected = yield* profiles.current.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      withProfileOverride(base, override),
    ),
  );
  return {
    ...selected,
    source:
      override === undefined ? selected.source : ("command-line" as const),
  };
});

export const resolveProfileName = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  return (yield* resolveProfileSelection(envFile, override)).name;
});

export const resourceFilter = Flag.string("filter").pipe(
  Flag.withDescription(
    "Comma-separated logical resource IDs (e.g. Api,Sandbox). Only those resources are included.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const TAIL_COLORS = [
  "\x1b[36m", // cyan
  "\x1b[35m", // magenta
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[34m", // blue
  "\x1b[91m", // bright red
  "\x1b[96m", // bright cyan
  "\x1b[95m", // bright magenta
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
];
export const TAIL_RESET = "\x1b[0m";

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
    throw new Error(
      `Invalid --since value: '${value}'. Use a duration (e.g. '1h', '30m') or ISO date.`,
    );
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
export const profileTui = Effect.promise(
  () => import("../tui/components/Profile.tsx"),
);

/**
 * Resolve a profile's stored credential entries into display records —
 * provider name, method, live status, and detail lines. Provider
 * `prettyPrint` output is captured through Effect's Console service so it
 * can be composed into the profile card (or serialized as JSON) instead of
 * being emitted as unrelated loose lines.
 */
export const resolveProfileDisplay = Effect.fn(function* (
  profile: string,
  stored: Profile,
  registry: AuthProviders["Service"],
) {
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

      const lines: string[] = [];
      const capture = (...args: ReadonlyArray<unknown>) => {
        lines.push(format(...args).trimStart());
      };
      const capturedConsole = {
        ...globalThis.console,
        log: capture,
        info: capture,
        warn: capture,
        error: capture,
      } as Console.Console;

      // A provider's `prettyPrint` catches its own credential-resolution
      // failures, but some resolve paths `Effect.orDie` (e.g. AWS SSO with an
      // expired token), which escapes as a defect. Contain it here so one broken
      // provider can't abort rendering the rest of the profile.
      let failed = false;
      yield* provider.prettyPrint(profile, cfg).pipe(
        Effect.provideService(Console.Console, capturedConsole),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          const message =
            error instanceof Error ? error.message : String(error);
          return Effect.sync(() => {
            failed = true;
            lines.push(`Failed to retrieve credentials: ${message}`);
          });
        }),
      );
      return {
        name,
        method: cfg.method,
        status: failed ? ("error" as const) : ("ready" as const),
        lines: lines.filter((line) => line !== `source: ${cfg.method}`),
      };
    });

  // `prettyPrint` is read-only but resolves live credentials (SSO, OAuth
  // refresh, whoami calls) — render providers concurrently so wall time is
  // the slowest provider, not the sum.
  return yield* Effect.forEach(Object.keys(stored).sort(), renderProvider, {
    concurrency: 4,
  });
});

/**
 * Render a profile's stored credential entries in an Ink box across
 * `alchemy profile edit`, `alchemy profile show`, and the interactive hub.
 */
export const printProfile = Effect.fn(function* (
  profile: string,
  stored: Profile,
  registry: AuthProviders["Service"],
  active = true,
) {
  const providers = yield* resolveProfileDisplay(profile, stored, registry);
  const { renderProfileDetails } = yield* profileTui;
  yield* Effect.sync(() => renderProfileDetails(profile, providers, active));
});

export const importStack = Effect.fn(function* (main: string) {
  const path = yield* Path.Path;
  // Build a `file://` URL from the absolute path. `import.meta.resolve` expects a
  // module specifier / URL, not a raw filesystem path: on Windows an absolute
  // path like `D:\stack.ts` is not a valid specifier and fails to resolve, so the
  // CLI cannot load the user's stack. `pathToFileURL` produces a valid URL on
  // every platform.
  const url = pathToFileURL(path.resolve(main)).href;
  const module = yield* Effect.promise(() => import(url));
  const stackEffect = module.default as ReturnType<
    ReturnType<typeof Stack.make>
  >;
  if (!Effect.isEffect(stackEffect)) {
    return yield* Effect.die(
      new Error(
        `Main file '${main}' must export a default stack definition (export default Alchemy.Stack({...}))`,
      ),
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
  profile: string;
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
 * Shared by `alchemy profile show` and `alchemy unsafe nuke`. The caller
 * decides what to do with the result — use `authProviders` (profile show) or
 * `context` (nuke) — and whether a missing/invalid entrypoint is fatal (nuke
 * lets it propagate) or best-effort (profile show wraps the call in
 * `Effect.catchCause`).
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
