import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as PlatformConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as S from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import packageJson from "../package.json";
import { apply } from "../src/Apply.ts";
import * as AWSAccount from "../src/AWS/Account.ts";
import { bootstrap as bootstrapAws } from "../src/AWS/Bootstrap.ts";
import * as AWSCredentials from "../src/AWS/Credentials.ts";
import * as AWSEndpoint from "../src/AWS/Endpoint.ts";
import * as AWSRegion from "../src/AWS/Region.ts";
import * as CLI from "../src/Cli/index.ts";
import { dotAlchemy } from "../src/Config.ts";
import * as Plan from "../src/Plan.ts";
import { Stack, StackSpec } from "../src/Stack.ts";
import * as State from "../src/State/index.ts";

// Import to trigger module augmentation for StageConfig.aws
import "../src/aws/config.ts";
import { Stage } from "../src/Stage.ts";

const USER = Config.string("USER").pipe(
  Config.orElse(() => Config.string("USERNAME")),
  Config.withDefault("unknown"),
);

const STAGE = Config.string("stage").pipe(
  Config.option,
  (a) => a.asEffect(),
  Effect.map(Option.getOrUndefined),
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

const main = Argument.file("main", {
  mustExist: true,
}).pipe(
  Argument.withDescription("Main file to deploy, defaults to alchemy.run.ts"),
  Argument.withDefault("alchemy.run.ts"),
);

const deployCommand = Command.make(
  "deploy",
  {
    dryRun,
    main,
    envFile,
    stage,
    yes,
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
  },
  (args) =>
    execStack({
      ...args,
      // plan is the same as deploy with dryRun always set to true
      dryRun: true,
    }),
);

const awsProfile = Flag.string("profile").pipe(
  Flag.withDescription("AWS profile to use for credentials"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const awsRegion = Flag.string("region").pipe(
  Flag.withDescription(
    "AWS region to bootstrap (defaults to AWS_REGION env var)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile: awsProfile,
    region: awsRegion,
  },
  (args) => {
    // Create a minimal app config for bootstrap
    // Use "default" profile if none specified

    const awsLayers = Layer.mergeAll(
      AWSAccount.fromStageConfig(),
      AWSRegion.fromStageConfig(),
      AWSCredentials.fromStageConfig(),
      AWSEndpoint.fromStageConfig(),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(
          Stack,
          Stack.of({
            name: "bootstrap",
            stage: "bootstrap",
            bindings: {},
            resources: {},
          }),
        ),
      ),
    );

    const platform = Layer.mergeAll(
      NodeServices.layer,
      FetchHttpClient.layer,
      Logger.layer([Logger.consolePretty()]),
    );

    // Build configProvider effect that requires platform (for fromDotEnv)
    const configProviderEffect = Option.isSome(args.envFile)
      ? Effect.map(
          PlatformConfigProvider.fromDotEnv({
            path: args.envFile.value,
          }),
          (dotEnv) => ConfigProvider.orElse(dotEnv, ConfigProvider.fromEnv()),
        )
      : Effect.succeed(ConfigProvider.fromEnv());

    return Effect.gen(function* () {
      const provider = yield* configProviderEffect;
      yield* bootstrapAws().pipe(
        Effect.tap(({ bucketName, created }) =>
          created
            ? Effect.logInfo(`✓ Created assets bucket: ${bucketName}`)
            : Effect.logInfo(`✓ Assets bucket already exists: ${bucketName}`),
        ),
        Effect.provide(
          Layer.provide(
            awsLayers,
            Layer.succeed(ConfigProvider.ConfigProvider, provider),
          ),
        ),
      );
    }).pipe(Effect.provide(platform)) as Effect.Effect<void, any, never>;
  },
);

const execStack = Effect.fn(function* ({
  main,
  stage,
  envFile,
  dryRun = false,
  yes = false,
  destroy = false,
}: {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  dryRun?: boolean;
  yes?: boolean;
  destroy?: boolean;
}) {
  const path = yield* Path;
  const module = yield* Effect.promise(
    () => import(path.resolve(process.cwd(), main)),
  );
  const stackEffect = module.default as Effect.Effect<StackSpec>;
  if (!stackEffect) {
    return yield* Effect.die(
      new Error(
        `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
      ),
    );
  }

  const configProvider = Option.isSome(envFile)
    ? ConfigProvider.orElse(
        yield* PlatformConfigProvider.fromDotEnv({
          path: envFile.value,
        }),
        ConfigProvider.fromEnv(),
      )
    : ConfigProvider.fromEnv();

  // TODO(sam): implement local and watch
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  // override alchemy state store, CLI/reporting and dotAlchemy
  const alchemy = Layer.mergeAll(
    // TODO(sam): support overriding these
    State.LocalState,
    CLI.inkCLI(),
    // optional
    dotAlchemy,
  );

  yield* Effect.gen(function* () {
    const cli = yield* CLI.Cli;
    const stack = yield* stackEffect;
    const updatePlan = yield* Plan.make(
      destroy
        ? {
            ...stack,
            // zero these out (destroy will treat all as orphans)
            // TODO(sam): probably better to have Plan.destroy and Plan.update
            resources: {},
            bindings: {},
          }
        : stack,
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

const root = Command.make("alchemy-effect", {}).pipe(
  Command.withSubcommands([
    bootstrapCommand,
    deployCommand,
    destroyCommand,
    planCommand,
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
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
