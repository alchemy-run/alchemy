import { Args, Command, Options } from "@effect/cli";
import * as HelpDoc from "@effect/cli/HelpDoc";
import * as ValidationError from "@effect/cli/ValidationError";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Path } from "@effect/platform/Path";
import * as PlatformConfigProvider from "@effect/platform/PlatformConfigProvider";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import packageJson from "../package.json";
import * as App from "../src/app.ts";
import { applyPlan } from "../src/apply.ts";
import * as AWSAccount from "../src/aws/account.ts";
import { bootstrap as bootstrapAws } from "../src/aws/bootstrap.ts";
import * as AWSCredentials from "../src/aws/credentials.ts";
import * as AWSEndpoint from "../src/aws/endpoint.ts";
import * as AWSRegion from "../src/aws/region.ts";
import * as CLI from "../src/cli/index.ts";
import { dotAlchemy } from "../src/dot-alchemy.ts";
import { plan } from "../src/plan.ts";
import { Resource } from "../src/resource.ts";
import type { Stack } from "../src/stack.ts";
import * as State from "../src/state.ts";
import { asEffect } from "../src/util.ts";
// Import to trigger module augmentation for StageConfig.aws
import "../src/aws/config.ts";

const USER = Config.string("USER").pipe(
  Config.orElse(() => Config.string("USERNAME")),
  Config.withDefault("unknown"),
);

const STAGE = Config.string("stage").pipe(
  Config.option,
  Effect.map(Option.getOrUndefined),
);

const stage = Options.text("stage").pipe(
  Options.withDescription("Stage to deploy to, defaults to dev_${USER}"),
  Options.optional,
  Options.map(Option.getOrUndefined),
  Options.mapEffect(
    Effect.fn(function* (stage) {
      if (stage) {
        return stage;
      }
      return yield* STAGE.pipe(
        Effect.catchAll((err) =>
          Effect.fail(ValidationError.invalidValue(HelpDoc.p(err.message))),
        ),
        Effect.flatMap((s) =>
          s === undefined
            ? USER.pipe(
                Effect.map((user) => `dev_${user}`),
                Effect.catchAll(() => Effect.succeed("unknown")),
              )
            : Effect.succeed(s),
        ),
      );
    }),
  ),
  Options.mapEffect((stage) => {
    const regex = /^[a-z0-9]+([-_a-z0-9]+)*$/gi;
    return regex.test(stage)
      ? Effect.succeed(stage)
      : Effect.fail(
          ValidationError.invalidValue(
            HelpDoc.p(
              `Stage '${stage}' is invalid. Must match the regex ${regex.source} (alphanumeric characters, hyphens and dashes).`,
            ),
          ),
        );
  }),
);

const envFile = Options.file("env-file").pipe(
  Options.optional,
  Options.withDescription(
    "File to load environment variables from, defaults to .env",
  ),
);

const dryRun = Options.boolean("dry-run").pipe(
  Options.withDescription("Dry run the deployment, do not actually deploy"),
  Options.withDefault(false),
);

const yes = Options.boolean("yes").pipe(
  Options.withDescription("Yes to all prompts"),
  Options.withDefault(false),
);

const main = Args.file({
  name: "main",
  exists: "yes",
}).pipe(
  Args.withDescription("Main file to deploy, defaults to alchemy.run.ts"),
  Args.withDefault("alchemy.run.ts"),
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
  (args) =>
    execStack({
      ...args,
      select: (stack) => stack.resources,
    }),
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
      // destroy is just a plan with 0 resources
      select: () => [],
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
      select: (stack) => stack.resources,
    }),
);

const awsProfile = Options.text("profile").pipe(
  Options.withDescription("AWS profile to use for credentials"),
  Options.optional,
  Options.map(Option.getOrUndefined),
);

const awsRegion = Options.text("region").pipe(
  Options.withDescription(
    "AWS region to bootstrap (defaults to AWS_REGION env var)",
  ),
  Options.optional,
  Options.map(Option.getOrUndefined),
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
    const appLayer = App.make({
      name: "bootstrap",
      stage: "bootstrap",
      config: {
        aws: {
          profile: args.profile ?? "default",
          region: args.region,
        },
      },
    });

    const awsLayers = Layer.mergeAll(
      AWSAccount.fromStageConfig(),
      AWSRegion.fromStageConfig(),
      AWSCredentials.fromStageConfig(),
      AWSEndpoint.fromStageConfig(),
    ).pipe(Layer.provideMerge(appLayer));

    const platform = Layer.mergeAll(
      NodeContext.layer,
      FetchHttpClient.layer,
      Logger.pretty,
    );

    // Build configProvider effect that requires platform (for fromDotEnv)
    const configProviderEffect = Option.isSome(args.envFile)
      ? Effect.map(
          PlatformConfigProvider.fromDotEnv(args.envFile.value),
          (dotEnv) => ConfigProvider.orElse(dotEnv, ConfigProvider.fromEnv),
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
        Effect.provide(awsLayers),
        Effect.withConfigProvider(provider),
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
  select,
}: {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  dryRun?: boolean;
  yes?: boolean;
  select: (stack: Stack<string, any, never, never, never, never>) => Resource[];
}) {
  const path = yield* Path;
  const module = yield* Effect.promise(
    () => import(path.resolve(process.cwd(), main)),
  );
  const stack = module.default as Stack<
    string,
    any,
    never,
    never,
    never,
    never
  >;
  if (!stack) {
    return yield* Effect.die(
      new Error(
        `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
      ),
    );
  }

  const stackName = stack.name;

  const configProvider = Option.isSome(envFile)
    ? ConfigProvider.orElse(
        yield* PlatformConfigProvider.fromDotEnv(envFile.value),
        ConfigProvider.fromEnv,
      )
    : ConfigProvider.fromEnv();

  const stageConfig = yield* asEffect(stack.stages.config(stage)).pipe(
    Effect.provide(stack.layers ?? Layer.empty),
    Effect.withConfigProvider(configProvider),
  );

  // TODO(sam): implement local and watch
  const platform = Layer.mergeAll(
    NodeContext.layer,
    FetchHttpClient.layer,
    Logger.pretty,
  );

  // override alchemy state store, CLI/reporting and dotAlchemy
  const alchemy = Layer.mergeAll(
    stack.state ?? State.localFs,
    stack.cli ?? CLI.inkCLI(),
    // optional
    dotAlchemy,
  );

  const layers = Layer.provideMerge(
    Layer.provideMerge(stack.providers, alchemy),
    Layer.mergeAll(
      platform,
      App.make({
        name: stackName,
        stage,
        config: stageConfig,
      }),
    ),
  );

  yield* Effect.gen(function* () {
    const cli = yield* CLI.CLI;
    const resources = select(stack);
    const updatePlan = yield* plan(...resources);
    if (dryRun) {
      yield* cli.displayPlan(updatePlan);
    } else {
      if (!yes) {
        const approved = yield* cli.approvePlan(updatePlan);
        if (!approved) {
          return;
        }
      }
      const outputs = yield* applyPlan(updatePlan);
      if (outputs && stack.tap) {
        yield* stack
          .tap(outputs)
          .pipe(Effect.provide(stack.layers ?? Layer.empty));
      }
    }
  }).pipe(
    Effect.provide(layers),
    Effect.withConfigProvider(configProvider),
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
  name: "Alchemy Effect CLI",
  version: packageJson.version,
});

// Prepare and run the CLI application
cli(process.argv).pipe(
  // $USER and $STAGE are set by the environment
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
);
