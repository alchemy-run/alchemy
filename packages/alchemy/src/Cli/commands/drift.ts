import * as ConfigProvider from "effect/ConfigProvider";
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
import * as CLI from "../../Cli/Cli.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { Stage } from "../../Stage.ts";
import * as Sync from "../../Sync.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  config,
  envFile,
  exitDeclined,
  importStack,
  instrumentCommand,
  profile,
  stage,
  yes,
} from "./_shared.ts";

const repairFlag = Flag.boolean("repair").pipe(
  Flag.withDescription(
    "Repair detected drift after showing and confirming the plan",
  ),
  Flag.withDefault(false),
);

interface SyncArgs {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  profile?: string;
  repair?: boolean;
  yes?: boolean;
}

const execDrift = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  repair = false,
  yes = false,
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
    const cli = yield* CLI.Cli;
    const kit = yield* CliKit.CliKit;
    const { stack, result, plan } = yield* Effect.acquireUseRelease(
      kit.terminal.input
        ? kit.live.progress({
            label: "Preparing drift check",
            detail: `stage ${stage}`,
          })
        : Effect.succeed(undefined),
      (progress) =>
        Effect.gen(function* () {
          if (progress !== undefined) {
            yield* progress.update({ label: "Loading stack", detail: main });
          }
          const stack = yield* stackEffect;
          if (progress !== undefined) {
            yield* progress.update({
              label: "Checking resources for drift",
              detail: stack.stage,
            });
          }
          const { result, plan } = yield* Sync.plan({
            name: stack.name,
            stage: stack.stage,
          }).pipe(Effect.provide(stack.services));
          return { stack, result, plan };
        }),
      (progress) => progress?.close ?? Effect.void,
    );

    yield* Effect.gen(function* () {
      if (!repair) {
        yield* cli.displayPlan(plan);
        return;
      }

      const hasChanges = Object.values(result.resources).some(
        (r) => r.action === "drifted" || r.action === "missing",
      );
      if (!yes && hasChanges) {
        const approved = yield* cli.approvePlan(plan);
        if (!approved) {
          return yield* exitDeclined;
        }
      }

      // Repair pass: re-observes the cloud (rather than trusting the
      // detection snapshot) and reports progress through the session.
      const session = yield* cli.startApplySession(plan);
      yield* Sync.sync({ name: stack.name, stage: stack.stage }, { session });
    }).pipe(Effect.provide(stack.services));
  }).pipe(Effect.provide(services));
});

export const driftCommand = Command.make(
  "drift",
  {
    repair: repairFlag,
    main: config,
    envFile,
    stage,
    yes,
    profile,
  },
  instrumentCommand("drift", (args: SyncArgs & { repair: boolean }) => ({
    "alchemy.stage": args.stage,
    "alchemy.profile": args.profile,
    "alchemy.main": args.main,
    "alchemy.repair": args.repair,
  }))((args) => execDrift(args)),
).pipe(Command.withDescription("Detect infrastructure drift"));
