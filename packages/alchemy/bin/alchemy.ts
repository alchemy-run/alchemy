import * as Auth from "@distilled.cloud/aws/Auth";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import type { FileSystem } from "effect/FileSystem";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import packageJson from "../package.json" with { type: "json" };
import { apply } from "../src/Apply.ts";
import { provideFreshArtifactStore } from "../src/Artifacts.ts";
import { AuthError, AuthProviders } from "../src/Auth/AuthProvider.ts";
import {
  getProfile,
  setProfile,
  withProfileOverride,
} from "../src/Auth/Profile.ts";
import { PromptCancelled } from "../src/Util/Clank.ts";
import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../src/AWS/Bootstrap.ts";
import * as AWSCredentials from "../src/AWS/Credentials.ts";
import * as AWSEnvironment from "../src/AWS/Environment.ts";
import * as AWSRegion from "../src/AWS/Region.ts";
import * as CLI from "../src/Cli/index.ts";
import { dotAlchemy } from "../src/Config.ts";
import * as Plan from "../src/Plan.ts";
import { findProviderByType, type LogLine } from "../src/Provider.ts";
import * as Stack from "../src/Stack.ts";
import { Stage } from "../src/Stage.ts";
import * as State from "../src/State/index.ts";
import { loadConfigProvider } from "../src/Util/ConfigProvider.ts";
import { fileLogger } from "../src/Util/FileLogger.ts";
import { PlatformServices, runMain } from "../src/Util/PlatformServices.ts";

const USER = Config.string("USER").pipe(
  Config.orElse(() => Config.string("USERNAME")),
  Config.withDefault("unknown"),
);

const STAGE = Config.string("stage").pipe(
  Config.option,
  (a) => a.asEffect(),
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
const handleCancellation = <A, E, R>(self: Effect.Effect<A, E, R>) =>
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

const stage = Flag.string("stage").pipe(
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
            ? USER.asEffect().pipe(
                Effect.map((user) => `dev_${user}`),
                Effect.catch(() => Effect.succeed("unknown")),
              )
            : Effect.succeed(s),
        ),
      );
    }),
  ),
);

const envFile = Flag.file("env-file").pipe(
  Flag.optional,
  Flag.withDescription(
    "File to load environment variables from, defaults to .env",
  ),
);

const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Dry run the deployment, do not actually deploy"),
  Flag.withDefault(false),
);

const yes = Flag.boolean("yes").pipe(
  Flag.withDescription("Yes to all prompts"),
  Flag.withDefault(false),
);

const force = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force updates for resources that would otherwise no-op",
  ),
  Flag.withDefault(false),
);

const main = Argument.file("main", {
  mustExist: true,
}).pipe(
  Argument.withDescription("Main file to deploy, defaults to alchemy.run.ts"),
  Argument.withDefault("alchemy.run.ts"),
);

const profile = Flag.string("profile").pipe(
  Flag.withDescription(
    "Auth profile to use (~/.alchemy/profiles.json). Defaults to 'default' or $ALCHEMY_PROFILE.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const deployCommand = Command.make(
  "deploy",
  {
    dryRun,
    force,
    main,
    envFile,
    stage,
    yes,
    profile,
  },
  (args) => execStack(args),
);

const destroyCommand = Command.make(
  "destroy",
  {
    dryRun,
    main,
    envFile,
    stage,
    yes,
    profile,
  },
  (args) =>
    execStack({
      ...args,
      destroy: true,
    }),
);

const planCommand = Command.make(
  "plan",
  {
    main,
    envFile,
    stage,
    profile,
  },
  (args) =>
    execStack({
      ...args,
      // plan is the same as deploy with dryRun always set to true
      dryRun: true,
    }),
);

const execStack = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  dryRun = false,
  force = false,
  yes = false,
  destroy = false,
}: {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  profile: string | undefined;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  destroy?: boolean;
}) {
  const path = yield* Path;
  const module = yield* Effect.promise(
    () => import(path.resolve(process.cwd(), main)),
  );
  const stackEffect = module.default as ReturnType<
    ReturnType<typeof Stack.make>
  >;
  if (!stackEffect) {
    return yield* Effect.die(
      new Error(
        `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
      ),
    );
  }

  const configProvider = withProfileOverride(
    yield* loadConfigProvider(envFile),
    profile,
  );

  // Shared registry that AuthProviderLayer entries write themselves into when
  // the stack's providers Layer is built.
  const authProviders: AuthProviders["Service"] = {};

  // TODO(sam): implement local and watch
  const platform = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

  const rootLogger = Logger.layer([fileLogger("out")]);

  // override alchemy state store, CLI/reporting and dotAlchemy
  const alchemy = Layer.mergeAll(
    // TODO(sam): support overriding these
    State.LocalState,
    CLI.inkCLI(),
    // optional
    Layer.provideMerge(rootLogger, dotAlchemy),
  );

  yield* Effect.gen(function* () {
    const cli = yield* CLI.Cli;
    const stack = yield* stackEffect;

    yield* Effect.gen(function* () {
      const updatePlan = yield* Plan.make(
        destroy
          ? {
              ...stack,
              // zero these out (destroy will treat all as orphans)
              // TODO(sam): probably better to have Plan.destroy and Plan.update
              resources: {},
              bindings: {},
              output: {},
            }
          : stack,
        { force },
      );
      if (dryRun) {
        yield* cli.displayPlan(updatePlan);
      } else {
        if (!yes) {
          const approved = yield* cli.approvePlan(updatePlan);
          if (!approved) {
            return;
          }
        }
        const outputs = yield* apply(updatePlan);

        yield* Console.log(outputs);
      }
    }).pipe(
      Effect.provide(stack.services),
      provideFreshArtifactStore,
      // Effect.provide(Logger.layer([fileLogger("stacks", stack.name, stage)])),
    );
  }).pipe(
    // AuthProviders must be in scope when the stack's providers Layer is
    // built so each provider's AuthProviderLayer can register itself.
    Effect.provideService(AuthProviders, authProviders),
    Effect.provide(
      Layer.provideMerge(
        alchemy,
        Layer.mergeAll(platform, Layer.succeed(Stage, stage)),
      ),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
  ) as Effect.Effect<void, any, never>;
  // TODO(sam): figure out why we need to cast to remove the Provider<never> requirement
  // Effect.Effect<void, any, Provider<never>>;
});

const resourceFilter = Flag.string("filter").pipe(
  Flag.withDescription(
    "Comma-separated logical resource IDs (e.g. Api,Sandbox). Only those resources are included.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const tailCommand = Command.make(
  "tail",
  {
    main,
    envFile,
    stage,
    filter: resourceFilter,
  },
  Effect.fnUntraced(function* ({
    main,
    stage,
    envFile,
    filter,
  }: {
    main: string;
    stage: string;
    envFile: Option.Option<string>;
    filter: string | undefined;
  }) {
    const path = yield* Path;
    const module = yield* Effect.promise(
      () => import(path.resolve(process.cwd(), main)),
    );
    const stackEffect = module.default as ReturnType<
      ReturnType<typeof Stack.make>
    >;
    if (!stackEffect) {
      return yield* Effect.die(
        new Error(
          `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
        ),
      );
    }

    const configProvider = yield* loadConfigProvider(envFile);

    const platform = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

    const rootLogger = Logger.layer([fileLogger("out")]);

    const alchemy = Layer.mergeAll(
      State.LocalState,
      Layer.provideMerge(rootLogger, dotAlchemy),
    );

    yield* Effect.gen(function* () {
      const state = yield* State.State;
      const stack = yield* stackEffect;

      yield* Effect.gen(function* () {
        const filterSet = parseResourceFilter(filter);
        const availableIds = [
          ...new Set(Object.values(stack.resources).map((r) => r.LogicalId)),
        ].sort();

        if (filterSet) {
          for (const id of filterSet) {
            if (!availableIds.includes(id)) {
              return yield* Effect.die(
                new Error(
                  `Unknown resource '${id}' in --filter. Available: ${availableIds.join(", ") || "(none)"}`,
                ),
              );
            }
          }
        }

        const fqns = Object.keys(stack.resources);
        const tailable: {
          logicalId: string;
          stream: Stream.Stream<LogLine, any, any>;
        }[] = [];

        for (const fqn of fqns) {
          const resource = stack.resources[fqn]!;
          if (filterSet && !filterSet.has(resource.LogicalId)) continue;

          const resourceState = yield* state.get({
            stack: stack.name,
            stage: stack.stage,
            fqn,
          });
          if (!resourceState?.attr) continue;

          const provider = yield* findProviderByType(resource.Type);
          if (!provider.tail) continue;

          tailable.push({
            logicalId: resource.LogicalId,
            stream: provider.tail({
              id: resource.LogicalId,
              instanceId: resourceState.instanceId,
              props: resourceState.props as any,
              output: resourceState.attr as any,
            }),
          });
        }

        if (tailable.length === 0) {
          if (filterSet) {
            yield* Console.log(
              "No tailable resources match --filter (deploy first, or selected resources may not support tail).",
            );
          } else {
            yield* Console.log(
              "No tailable resources found. Deploy first, then run tail.",
            );
          }
          return;
        }

        yield* Console.log(
          `Tailing: ${tailable.map((t) => t.logicalId).join(", ")}`,
        );

        const taggedStreams = tailable.map(({ logicalId, stream }, i) => {
          const color = TAIL_COLORS[i % TAIL_COLORS.length]!;
          return stream.pipe(
            Stream.map(({ timestamp, message }) => {
              const ts = formatLocalTimestamp(timestamp);
              return `${color}${ts} [${logicalId}]${TAIL_RESET} ${message}`;
            }),
          );
        });

        yield* Stream.mergeAll(taggedStreams, {
          concurrency: "unbounded",
        }).pipe(Stream.runForEach((line) => Console.log(line)));
      }).pipe(Effect.provide(stack.services));
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          alchemy,
          Layer.mergeAll(platform, Layer.succeed(Stage, stage)),
        ),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.scoped,
    ) as Effect.Effect<void, any, never>;
  }),
);

const awsProfile = Flag.string("profile").pipe(
  Flag.withDescription("AWS profile to use for credentials"),
  Flag.optional,
  Flag.map(Option.getOrElse(() => "default")),
);

const awsRegion = Flag.string("region").pipe(
  Flag.withDescription(
    "AWS region to bootstrap (defaults to AWS_REGION env var)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapDestroy = Flag.boolean("destroy").pipe(
  Flag.withDescription("Destroy all bootstrap buckets in the selected region"),
  Flag.withDefault(false),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile: awsProfile,
    region: awsRegion,
    destroy: bootstrapDestroy,
  },
  Effect.fnUntraced(function* ({ envFile, profile, region, destroy }) {
    const platform = Layer.mergeAll(
      PlatformServices,
      FetchHttpClient.layer,
      Layer.provideMerge(
        Logger.layer([fileLogger("bootstrap.txt")]),
        dotAlchemy,
      ),
    );

    return yield* Effect.gen(function* () {
      const ssoProfile = yield* Auth.loadProfile(profile);
      if (!ssoProfile.sso_account_id) {
        return yield* Effect.die(
          `AWS SSO profile '${profile}' is missing sso_account_id`,
        );
      }

      // Build a single AWSEnvironment, then derive Region/Credentials from
      // it so resource providers downstream see a consistent view. The
      // credentials Effect captures FileSystem/Path/HttpClient via the
      // ambient context; AWSEnvironment expects R=never, so we provide it
      // here.
      const ambient = yield* Effect.context<FileSystem | Path | HttpClient>();
      const environment = AWSEnvironment.makeEnvironment({
        accountId: ssoProfile.sso_account_id,
        region: region ?? ssoProfile.region ?? "us-east-1",
        credentials: Auth.loadProfileCredentials(profile).pipe(
          Effect.provide(ambient),
        ),
        profile,
      });

      const awsLayers = Layer.provideMerge(
        Layer.mergeAll(
          AWSRegion.fromEnvironment,
          AWSCredentials.fromEnvironment,
        ),
        environment,
      );

      return yield* Effect.gen(function* () {
        const provider = yield* loadConfigProvider(envFile);
        const bootstrapLayer = Layer.provide(
          awsLayers,
          Layer.succeed(ConfigProvider.ConfigProvider, provider),
        );
        if (destroy) {
          yield* destroyBootstrapAws().pipe(
            Effect.tap((result) =>
              result.destroyed === 0
                ? Console.log("✓ No bootstrap buckets found to destroy")
                : Console.log(
                    `✓ Destroyed ${result.destroyed} bootstrap bucket(s): ${result.bucketNames.join(", ")}`,
                  ),
            ),
            Effect.provide(bootstrapLayer),
          );
          return;
        }
        yield* bootstrapAws().pipe(
          Effect.tap(({ bucketName, created }) =>
            created
              ? Console.log(`✓ Created assets bucket: ${bucketName}`)
              : Console.log(`✓ Assets bucket already exists: ${bucketName}`),
          ),
          Effect.provide(bootstrapLayer),
        );
      });
    }).pipe(Effect.provide(platform)) as Effect.Effect<void, any, never>;
  }),
);

const devCommand = Command.make(
  "dev",
  {
    main,
    envFile,
    stage,
  },
  ({ envFile, main, stage }) =>
    Effect.gen(function* () {
      const cmd = ChildProcess.make("bun", ["--hot", main], {
        env: {
          ALCHEMY_PHASE: "dev",
        },
      });

      const proc = yield* cmd;

      proc.stdout;
      proc.stderr;
      proc.all;
    }),
);

const loginConfigure = Flag.boolean("configure").pipe(
  Flag.withDescription(
    "Run the provider's interactive configure step before logging in",
  ),
  Flag.withDefault(false),
);

const loginCommand = Command.make(
  "login",
  {
    main,
    envFile,
    stage,
    profile,
    configure: loginConfigure,
  },
  Effect.fnUntraced(function* ({
    main,
    stage,
    envFile,
    profile: profileArg,
    configure,
  }: {
    main: string;
    stage: string;
    envFile: Option.Option<string>;
    profile: string | undefined;
    configure: boolean;
  }) {
    const path = yield* Path;
    const module = yield* Effect.promise(
      () => import(path.resolve(process.cwd(), main)),
    );
    const stackEffect = module.default as ReturnType<
      ReturnType<typeof Stack.make>
    >;
    if (!stackEffect) {
      return yield* Effect.die(
        new Error(
          `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
        ),
      );
    }

    const profile = profileArg ?? "default";
    const authProviders: AuthProviders["Service"] = {};

    const configProvider = withProfileOverride(
      yield* loadConfigProvider(envFile),
      profile,
    );

    const platform = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

    const rootLogger = Logger.layer([fileLogger("out")]);

    const alchemy = Layer.mergeAll(
      State.LocalState,
      Layer.provideMerge(rootLogger, dotAlchemy),
    );

    yield* Effect.gen(function* () {
      // Build the stack — this triggers each provider's AuthProviderLayer,
      // which registers itself into the shared `authProviders` registry.
      yield* stackEffect;

      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const providers = Object.values(authProviders);

      if (providers.length === 0) {
        yield* Console.log(
          "No AuthProviders registered. Make sure the stack's providers() layer includes AuthProviderLayer entries.",
        );
        return;
      }

      yield* Effect.forEach(
        providers,
        (provider) =>
          Effect.gen(function* () {
            const existing = yield* getProfile(profile);
            const stored = existing?.[provider.name];

            let cfg: { method: string };
            if (configure || stored == null) {
              cfg = yield* provider.configure(profile, { ci });
              yield* setProfile(profile, {
                ...existing,
                [provider.name]: cfg,
              });
            } else {
              cfg = stored;
            }

            yield* provider.login(profile, cfg);
            yield* provider.prettyPrint(profile, cfg);
          }),
        { discard: true },
      );
    }).pipe(
      // AuthProviders MUST be provided before the stack module runs so the
      // factory calls inside each provider's layer write into the same
      // registry we read from below.
      Effect.provideService(AuthProviders, authProviders),
      Effect.provide(
        Layer.provideMerge(
          alchemy,
          Layer.mergeAll(platform, Layer.succeed(Stage, stage)),
        ),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.scoped,
    );
  }),
);

const TAIL_COLORS = [
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
const TAIL_RESET = "\x1b[0m";

const formatLocalTimestamp = (date: Date): string => {
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

const logsLimit = Flag.integer("limit").pipe(
  Flag.withDescription("Number of log entries to fetch"),
  Flag.withDefault(100),
);

const logsSince = Flag.string("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const logsCommand = Command.make(
  "logs",
  {
    main,
    envFile,
    stage,
    filter: resourceFilter,
    limit: logsLimit,
    since: logsSince,
  },
  Effect.fnUntraced(function* ({
    main,
    stage,
    envFile,
    filter,
    limit,
    since,
  }: {
    main: string;
    stage: string;
    envFile: Option.Option<string>;
    filter: string | undefined;
    limit: number;
    since: string | undefined;
  }) {
    const path = yield* Path;
    const module = yield* Effect.promise(
      () => import(path.resolve(process.cwd(), main)),
    );
    const stackEffect = module.default as ReturnType<
      ReturnType<typeof Stack.make>
    >;
    if (!stackEffect) {
      return yield* Effect.die(
        new Error(
          `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
        ),
      );
    }

    const configProvider = yield* loadConfigProvider(envFile);

    const platform = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

    const rootLogger = Logger.layer([fileLogger("out")]);

    const alchemy = Layer.mergeAll(
      State.LocalState,
      Layer.provideMerge(rootLogger, dotAlchemy),
    );

    const sinceDate = since ? parseSince(since) : undefined;

    yield* Effect.gen(function* () {
      const state = yield* State.State;
      const stack = yield* stackEffect;

      yield* Effect.gen(function* () {
        const filterSet = parseResourceFilter(filter);
        const availableIds = [
          ...new Set(Object.values(stack.resources).map((r) => r.LogicalId)),
        ].sort();

        if (filterSet) {
          for (const id of filterSet) {
            if (!availableIds.includes(id)) {
              return yield* Effect.die(
                new Error(
                  `Unknown resource '${id}' in --filter. Available: ${availableIds.join(", ") || "(none)"}`,
                ),
              );
            }
          }
        }

        const fqns = Object.keys(stack.resources);
        const allLogs: { logicalId: string; lines: LogLine[] }[] = [];

        for (const fqn of fqns) {
          const resource = stack.resources[fqn]!;
          if (filterSet && !filterSet.has(resource.LogicalId)) continue;

          const resourceState = yield* state.get({
            stack: stack.name,
            stage: stack.stage,
            fqn,
          });
          if (!resourceState?.attr) continue;

          const provider = yield* findProviderByType(resource.Type);
          if (!provider.logs) continue;

          const lines = yield* provider.logs({
            id: resource.LogicalId,
            instanceId: resourceState.instanceId,
            props: resourceState.props as any,
            output: resourceState.attr as any,
            options: { limit, since: sinceDate },
          });

          allLogs.push({ logicalId: resource.LogicalId, lines });
        }

        if (allLogs.length === 0) {
          if (filterSet) {
            yield* Console.log(
              "No resources with logs match --filter (deploy first, or selected resources may not expose logs).",
            );
          } else {
            yield* Console.log(
              "No resources with logs found. Deploy first, then run logs.",
            );
          }
          return;
        }

        const merged = allLogs
          .flatMap(({ logicalId, lines }, i) => {
            const color = TAIL_COLORS[i % TAIL_COLORS.length]!;
            return lines.map((line) => ({
              ...line,
              formatted: `${color}${formatLocalTimestamp(line.timestamp)} [${logicalId}]${TAIL_RESET} ${line.message}`,
            }));
          })
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        for (const entry of merged) {
          yield* Console.log(entry.formatted);
        }
      }).pipe(Effect.provide(stack.services));
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          alchemy,
          Layer.mergeAll(platform, Layer.succeed(Stage, stage)),
        ),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.scoped,
    ) as Effect.Effect<void, any, never>;
  }),
);

const parseResourceFilter = (
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

const parseSince = (value: string): Date => {
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

const root = Command.make("alchemy", {}).pipe(
  Command.withSubcommands([
    bootstrapCommand,
    deployCommand,
    destroyCommand,
    planCommand,
    tailCommand,
    logsCommand,
    loginCommand,
  ]),
);

// Set up the CLI application
const cli = Command.run(root, {
  // name: "Alchemy Effect CLI",
  version: packageJson.version,
});

// Prepare and run the CLI application
cli.pipe(
  // $USER and $STAGE are set by the environment
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv(),
  ),
  Effect.provide(PlatformServices),
  Effect.scoped,
  handleCancellation,
  runMain,
);
