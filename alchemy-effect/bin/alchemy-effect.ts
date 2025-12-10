import { Command, Options, Args } from "@effect/cli";
import * as ValidationError from "@effect/cli/ValidationError";
import * as HelpDoc from "@effect/cli/HelpDoc";
import * as ConfigProvider from "effect/ConfigProvider";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Path } from "@effect/platform/Path";
import * as Logger from "effect/Logger";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { asEffect } from "../src/util.ts";
import packageJson from "../package.json";
import * as State from "../src/state.ts";
import { apply } from "../src/apply.ts";
import { plan } from "../src/plan.ts";
import { dotAlchemy } from "../src/dot-alchemy.ts";
import * as App from "../src/app.ts";
import type { Stack } from "../src/stack.ts";
import * as CLI from "../src/cli/index.ts";
import { loadDotEnv } from "../src/dotenv.ts";
import { displayPlan } from "../src/cli/display-plan.tsx";
import { Resource } from "../src/resource.ts";

const USER = Config.string("USER")
  .pipe(Config.orElse(() => Config.string("USERNAME")))
  .pipe(Config.withDefault("unknown"));

const stageRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const stageErrorMessage = (stage?: string) =>
  `Stage${stage ? ` '${stage}'` : ""} must be a valid stage name matching the regex ${stageRegex.source} (lowercase letters, numbers, and hyphens))`;

const STAGE = Config.string("stage").pipe(
  Config.option,
  Config.validate({
    message: stageErrorMessage(),
    validation: (stage) =>
      stage.pipe(
        Option.map((stage) => stageRegex.test(stage)),
        Option.getOrElse(() => true),
      ),
  }),
);

const stage = Options.text("stage").pipe(
  Options.withDescription("Stage to deploy to, defaults to dev_${USER}"),
  Options.mapEffect((stage) =>
    !stageRegex.test(stage)
      ? Effect.fail(
          ValidationError.invalidValue(HelpDoc.p(stageErrorMessage(stage))),
        )
      : Effect.succeed(stage),
  ),
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
  const user = yield* USER;
  stage ??= (yield* STAGE).pipe(Option.getOrElse(() => `dev_${user}`));

  const stackName = stack.name;
  const stageConfig = yield* asEffect(stack.stages.config(stage));

  // TODO(sam): implement local and watch
  const platform = Layer.mergeAll(
    NodeContext.layer,
    FetchHttpClient.layer,
    Logger.pretty,
  );

  // override alchemy state store, CLI/reporting and dotAlchemy
  const alchemy = Layer.mergeAll(
    stack.state ?? State.localFs,
    CLI.layer,
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
    const resources = select(stack);
    if (dryRun) {
      yield* displayPlan(yield* plan(...resources));
    } else {
      const outputs = yield* apply(...resources);
      if (stack.tap) {
        yield* stack
          .tap(outputs)
          .pipe(Effect.provide(stack.layers ?? Layer.empty));
      }
    }
  }).pipe(
    Effect.provide(layers),
    Effect.withConfigProvider(
      ConfigProvider.fromJson({
        // TODO(sam): ideally we can avoid referencing this and instead merge CofigProvider.fromEnv()?
        ...import.meta.env,
        ...(Option.isSome(envFile) ? yield* loadDotEnv(envFile.value) : {}),
      }),
    ),
  ) as Effect.Effect<void, any, never>;
  // TODO(sam): figure out why we need to cast to remove the Provider<never> requirement
  // Effect.Effect<void, any, Provider<never>>;
});

const root = Command.make("alchemy-effect", {}).pipe(
  Command.withSubcommands([deployCommand, destroyCommand, planCommand]),
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
