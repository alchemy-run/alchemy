import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Alchemist from "../../Alchemist/index.ts";
import * as Interaction from "../../Interaction.ts";
import { Cli } from "../../Report.ts";
import { renderApply } from "../../Report.ts";
import { planDecisionScreen } from "../components/view/PlanDecision.tsx";
import { setExitCode } from "./errors.ts";
import { config, envFile, profile, resolveStage, stage, yes } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";
import { renderPlanning } from "./render.ts";

/**
 * Exit code when drift was found and left unrepaired, so a scheduled job can
 * tell it apart from a clean stage (0) and a failed check (1), as
 * `terraform plan -detailed-exitcode` does.
 */
export const EXIT_DRIFT_DETECTED = 2;

const repairFlag = Flag.Boolean("repair").pipe(
  Flag.withDescription("Repair detected drift without prompting"),
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
  const cli = yield* Cli;
  const snapshot = yield* Alchemist.importStack(main).pipe(
    Effect.flatMap((stack) =>
      Alchemist.Drift.scan({
        stack,
        stage,
        profile,
        envFile: Option.getOrUndefined(envFile),
      }),
    ),
    renderPlanning({
      operation: "Drift",
      stage,
      computingLabel: "Checking drift",
      readyLabel: "Drift check complete",
    }),
  );
  if (!Alchemist.Drift.hasDrift(snapshot)) {
    return yield* cli.displayPlan(snapshot.native);
  }

  // `--yes` answers the repair prompt, so it repairs like `--repair`.
  if (!repair && !yes) {
    const terminal = yield* Interaction.Interaction;
    if (!terminal.terminal.input) {
      yield* cli.displayPlan(snapshot.native);
      return yield* setExitCode(EXIT_DRIFT_DETECTED);
    }
    const decision = yield* terminal.prompt
      .screen(
        planDecisionScreen({
          plan: snapshot.native,
          message: "Drift detected",
          choices: [
            {
              value: "repair" as const,
              label: "Repair",
            },
            {
              value: "cancel" as const,
              label: "Cancel",
            },
          ],
          initialValue: "cancel" as const,
        }),
      )
      .pipe(Effect.catchTag("TerminalCancelled", () => Effect.succeed("cancel" as const)));
    if (decision === "cancel") return yield* setExitCode(EXIT_DRIFT_DETECTED);
  }

  yield* Alchemist.Drift.execute(snapshot).pipe(renderApply(snapshot.native));
});

export const driftCommand = Command.make(
  "drift",
  {
    repair: repairFlag,
    yes,
    main: config,
    envFile,
    stage,
    profile,
  },
  (args) =>
    resolveStage("live", args.stage, args.envFile).pipe(
      Effect.flatMap((stage) =>
        instrumentCommand("drift", (a: SyncArgs & { repair: boolean }) => ({
          "alchemy.stage": a.stage,
          "alchemy.profile": a.profile,
          "alchemy.main": a.main,
          "alchemy.repair": a.repair,
        }))((resolved) => routeDrift(resolved))({ ...args, stage }),
      ),
    ),
).pipe(Command.withDescription("Detect infrastructure drift"));
