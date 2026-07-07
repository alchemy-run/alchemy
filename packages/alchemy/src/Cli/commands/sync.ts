import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { AdoptPolicy } from "../../AdoptPolicy.ts";
import { ArtifactStore, createArtifactStore } from "../../Artifacts.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import { Stage } from "../../Stage.ts";
import * as Sync from "../../Sync.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  importStack,
  instrumentCommand,
  profile,
  script,
  stage,
} from "./_shared.ts";

const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription(
    "Detect and report drift without repairing it (no reconcile, no state writes)",
  ),
  Flag.withDefault(false),
);

export interface SyncArgs {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  profile?: string;
  dryRun?: boolean;
}

export const execSync = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  dryRun = false,
}: SyncArgs) {
  const stackEffect = yield* importStack(main);

  const services = Layer.mergeAll(
    Layer.succeed(AdoptPolicy, false),
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
    Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
    Layer.succeed(Stage, stage),
  );

  yield* Effect.gen(function* () {
    const stack = yield* stackEffect;

    yield* Effect.gen(function* () {
      const result = yield* Sync.sync(
        { name: stack.name, stage: stack.stage },
        { dryRun },
      );
      yield* Console.log(Sync.printSync(result));
    }).pipe(Effect.provide(stack.services));
  }).pipe(Effect.provide(services));
});

export const syncCommand = Command.make(
  "sync",
  {
    dryRun: dryRunFlag,
    main: script,
    envFile,
    stage,
    profile,
  },
  instrumentCommand("sync", (args: SyncArgs) => ({
    "alchemy.stage": args.stage,
    "alchemy.profile": args.profile,
    "alchemy.main": args.main,
    "alchemy.dry_run": !!args.dryRun,
  }))(execSync),
);
