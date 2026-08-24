import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { DriftControl } from "../../AlchemyControl/DriftControl.ts";
import * as Operation from "../../AlchemyControl/Operation.ts";
import * as CLI from "../../Cli/Cli.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";

import {
  config,
  envFile,
  exitDeclined,
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

const routeDrift = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  repair = false,
  yes = false,
}: SyncArgs) {
  const cli = yield* CLI.Cli;
  const kit = yield* CliKit.CliKit;
  const drift = yield* DriftControl;
  const snapshot = yield* Effect.acquireUseRelease(
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
        return yield* drift.inspect({
          entrypoint: main,
          stage,
          profile,
          envFile: Option.getOrUndefined(envFile),
        });
      }),
    (progress) => progress?.close ?? Effect.void,
  );
  if (!repair) return yield* cli.displayPlan(snapshot.repairPlan.native);

  const hasChanges = snapshot.resources.some(
    (resource) =>
      resource.status === "drifted" || resource.status === "missing",
  );
  if (
    !yes &&
    hasChanges &&
    !(yield* cli.approvePlan(snapshot.repairPlan.native))
  ) {
    return yield* exitDeclined;
  }
  const session = yield* cli.startApplySession(snapshot.repairPlan.native);
  const operation = yield* drift.repair({
    driftId: snapshot.id,
    revision: snapshot.revision,
  });
  yield* Operation.run(operation, (event) => session.emit(event.event)).pipe(
    Effect.tapError(() => session.done("failure")),
  );
  yield* session.done("success");
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
  }))((args) => routeDrift(args)),
).pipe(Command.withDescription("Detect infrastructure drift"));
