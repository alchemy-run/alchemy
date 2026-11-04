import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Alchemist from "../../Alchemist/index.ts";
import { Cli } from "../../Report.ts";
import { setExitCode } from "./errors.ts";
import { config, envFile, profile, resolveStage, stage } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";
import { renderPlanning } from "./render.ts";

/**
 * Exit code when drift was found, so a scheduled job can tell it apart from
 * a clean stage (0) and a failed check (1), as
 * `terraform plan -detailed-exitcode` does.
 */
export const EXIT_DRIFT_DETECTED = 2;

interface DriftArgs {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  profile?: string;
}

/**
 * Report drift without changing anything. Repairs go through
 * `deploy --detect-drift`, which runs the stack program and so also
 * refreshes the stack's outputs.
 */
const routeDrift = Effect.fn(function* ({ main, stage, envFile, profile }: DriftArgs) {
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
  yield* cli.displayPlan(snapshot.native);
  if (Alchemist.Drift.hasDrift(snapshot)) {
    yield* setExitCode(EXIT_DRIFT_DETECTED);
  }
});

export const driftCommand = Command.make(
  "drift",
  {
    main: config,
    envFile,
    stage,
    profile,
  },
  (args) =>
    resolveStage("live", args.stage, args.envFile).pipe(
      Effect.flatMap((stage) =>
        instrumentCommand("drift", (a: DriftArgs) => ({
          "alchemy.stage": a.stage,
          "alchemy.profile": a.profile,
          "alchemy.main": a.main,
        }))((resolved) => routeDrift(resolved))({ ...args, stage }),
      ),
    ),
).pipe(Command.withDescription("Detect infrastructure drift (repair with deploy --detect-drift)"));
