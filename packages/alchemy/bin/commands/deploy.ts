import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";

import { apply } from "../../src/Apply.ts";
import { ArtifactStore, createArtifactStore } from "../../src/Artifacts.ts";
import { AuthProviders } from "../../src/Auth/AuthProvider.ts";
import { withProfileOverride } from "../../src/Auth/Profile.ts";
import * as CLI from "../../src/Cli/index.ts";
import * as Plan from "../../src/Plan.ts";
import { Stage } from "../../src/Stage.ts";
import { loadConfigProvider } from "../../src/Util/ConfigProvider.ts";
import { fileLogger } from "../../src/Util/FileLogger.ts";

import {
  dryRun as dryRunFlag,
  envFile,
  force,
  importStack,
  main,
  profile,
  stage,
  yes,
} from "./_shared.ts";

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
  profile: string;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  destroy?: boolean;
}) {
  const stackEffect = yield* importStack(main);

  const services = Layer.mergeAll(
    Layer.succeed(ArtifactStore, createArtifactStore()),
    Layer.succeed(
      AuthProviders,
      yield* Effect.serviceOption(AuthProviders).pipe(
        Effect.map(Option.getOrElse(() => ({}))),
      ),
    ),
    ConfigProvider.layer(
      withProfileOverride(yield* loadConfigProvider(envFile), profile),
    ),
    Logger.layer([fileLogger("out")]),
    Layer.succeed(Stage, stage),
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
        const hasChanges =
          Object.keys(updatePlan.deletions).length > 0 ||
          Object.values(updatePlan.resources).some(
            (node) =>
              node.action !== "noop" ||
              node.bindings.some((b) => b.action !== "noop"),
          );
        if (!yes && hasChanges) {
          const approved = yield* cli.approvePlan(updatePlan);
          if (!approved) {
            return;
          }
        }
        const outputs = yield* apply(updatePlan);

        yield* Console.log(outputs);
      }
    }).pipe(Effect.provide(stack.services));
  }).pipe(Effect.provide(services));
});

export const deployCommand = Command.make(
  "deploy",
  {
    dryRun: dryRunFlag,
    force,
    main,
    envFile,
    stage,
    yes,
    profile,
  },
  execStack,
);

export const destroyCommand = Command.make(
  "destroy",
  {
    dryRun: dryRunFlag,
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

export const planCommand = Command.make(
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
