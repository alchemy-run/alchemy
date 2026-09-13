import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import * as Drift from "../../Alchemist/routes/drift.ts";
import * as Stacks from "../../Alchemist/routes/stack.ts";
import * as Dashboard from "../../Dashboard/Launch.ts";
import { Cli } from "../../Report.ts";
import * as CliKit from "../CliKit/index.ts";
import { planDecisionScreen } from "../components/view/PlanDecision.tsx";
import { stackOutputsView } from "../components/view/StackOutputs.tsx";

import { exitDeclined } from "./errors.ts";
import {
  configPath,
  dryRun as dryRunFlag,
  envFile,
  force,
  optionalConfig,
  profile,
  resolveStackArgs,
  stage,
  yes,
} from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";
import { renderApply, renderPlanning } from "./render.ts";

interface StackCommandOptions {
  readonly main: string;
  readonly stage: string;
  readonly envFile: Option.Option<string>;
  readonly profile?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly destroy?: boolean;
  readonly adopt?: boolean;
  readonly detailed?: boolean;
  readonly detectDrift?: boolean;
  readonly ui?: boolean;
}

const stackSpanAttrs = (args: StackCommandOptions) => ({
  "alchemy.stage": args.stage,
  "alchemy.profile": args.profile,
  "alchemy.main": args.main,
  "alchemy.dry_run": !!args.dryRun,
  "alchemy.force": !!args.force,
  "alchemy.destroy": !!args.destroy,
  "alchemy.adopt": !!args.adopt,
  "alchemy.detailed": !!args.detailed,
  "alchemy.detect_drift": !!args.detectDrift,
  "alchemy.ui": !!args.ui,
});

const adopt = Flag.boolean("adopt").pipe(
  Flag.withDescription(
    "Adopt pre-existing cloud resources that conflict with this stack instead of failing. " +
      "Useful for re-importing infrastructure into a fresh state store.",
  ),
  Flag.withDefault(false),
);

const detailed = Flag.boolean("detailed").pipe(
  Flag.withDescription("Show declared resource properties as YAML"),
  Flag.withDefault(false),
);

const detectDrift = Flag.boolean("detect-drift").pipe(
  Flag.withDescription(
    "Detect infrastructure drift and offer to repair it before deploying",
  ),
  Flag.withDefault(false),
);

const ui = Flag.boolean("ui").pipe(
  Flag.withDescription(
    "Open the alchemy dashboard, approve the plan there, and stream this run into it. " +
      "Requires the optional @alchemy.run/dashboard package.",
  ),
  Flag.withDefault(false),
);

const detectAndMaybeRepairDrift = Effect.fn(function* (
  target: Stacks.StackTarget,
  options: {
    readonly yes?: boolean;
    readonly detailed?: boolean;
    readonly dryRun?: boolean;
  },
) {
  const cli = yield* Cli;
  const snapshot = yield* Drift.inspect(target).pipe(
    renderPlanning({
      operation: "Drift",
      stage: target.stage,
      computingLabel: "Checking drift",
      readyLabel: "Drift check complete",
    }),
  );
  if (!Drift.hasDrift(snapshot)) return true;

  if (options.dryRun) {
    yield* cli.displayPlan(snapshot.repairPlan.native, {
      detailed: options.detailed,
      stage: target.stage,
    });
    return true;
  }

  let decision: "repair" | "deploy" | "cancel" = options.yes
    ? "repair"
    : "cancel";
  if (!options.yes) {
    const terminal = yield* CliKit.CliKit;
    if (terminal.terminal.input) {
      decision = yield* terminal.prompt
        .custom(
          planDecisionScreen({
            plan: snapshot.repairPlan.native,
            message: "Drift detected",
            choices: [
              {
                value: "repair" as const,
                label: "Repair and Deploy",
              },
              {
                value: "deploy" as const,
                label: "Deploy without Repair",
              },
              {
                value: "cancel" as const,
                label: "Cancel",
              },
            ],
            initialValue: "repair" as const,
          }),
        )
        .pipe(
          Effect.catchTag("TerminalCancelled", () =>
            Effect.succeed("cancel" as const),
          ),
        );
    } else {
      yield* cli.displayPlan(snapshot.repairPlan.native, {
        detailed: options.detailed,
        stage: target.stage,
      });
      yield* CliKit.accessors.output.warning(
        "Drift detected in a non-interactive terminal. Re-run with --yes to repair and deploy.",
      );
    }
  }

  if (decision === "repair") {
    yield* Drift.repair(snapshot).pipe(
      renderApply(snapshot.repairPlan.native, {
        detailed: options.detailed,
        stage: target.stage,
      }),
    );
  }
  return decision !== "cancel";
});

const runStack = Effect.fn(function* (options: StackCommandOptions) {
  const cli = yield* Cli;
  const display = { detailed: options.detailed, stage: options.stage };
  const target = {
    entrypoint: options.main,
    stage: options.stage,
    profile: options.profile,
    envFile: Option.getOrUndefined(options.envFile),
  };

  const operation = options.destroy
    ? "Destroy"
    : options.dryRun
      ? "Plan"
      : "Deploy";
  const withPlanningProgress = renderPlanning({
    operation,
    stage: options.stage,
  });

  // --ui fails fast (with install instructions) when the optional
  // @alchemy.run/dashboard peer is missing — before any cloud interaction.
  if (options.ui) {
    yield* Dashboard.requireDistDir();
  }

  if (options.detectDrift && !options.destroy) {
    const proceed = yield* detectAndMaybeRepairDrift(target, options);
    if (!proceed) {
      yield* CliKit.accessors.output.info(
        "Deploy aborted: drift was detected and not approved.",
      );
      return yield* exitDeclined;
    }
  }

  const snapshot = yield* Stacks.plan({
    target,
    operation: options.destroy ? "destroy" : "deploy",
    force: options.force,
    adopt: options.adopt,
    updateStateStore: options.yes,
  }).pipe(withPlanningProgress);

  // --ui: bring the dashboard up AFTER the plan is computed, not before —
  // launching early opens a tab with nothing to show while planning bundles
  // and diffs, and the approval banner trailing in later reads as a glitch.
  // Post-plan, the tab opens with the plan overlay and the approve prompt
  // together. The reporter tee only needs the server up before APPLY
  // starts, which is always after planning.
  const dashboard = options.ui
    ? yield* Dashboard.ensureDashboard({
        target,
        stackName: snapshot.stack.name,
        command: options.destroy
          ? "destroy"
          : options.dryRun
            ? "plan"
            : "deploy",
        // opening a browser tab only makes sense where a human is looking
        open: (yield* CliKit.CliKit).terminal.input,
      }).pipe(
        Effect.tap((ensured) =>
          ensured === undefined
            ? CliKit.accessors.output.warning(
                "The dashboard did not start in time; continuing without --ui.",
              )
            : Effect.void,
        ),
      )
    : undefined;

  if (options.dryRun) {
    yield* cli.displayPlan(snapshot.native, display);
    if (dashboard?.launched) {
      // `plan --ui` exists to LOOK at the plan — keep serving until Ctrl+C
      yield* CliKit.accessors.output.info(
        `Dashboard serving at ${dashboard.url} — press Ctrl+C to exit.`,
      );
      yield* Effect.never;
    }
    return;
  }

  if (!options.yes && Stacks.hasChanges(snapshot.summary)) {
    const approved = yield* approvePlan(snapshot, {
      operation,
      display,
      dashboardUrl: dashboard?.url,
    });
    if (!approved) return yield* exitDeclined;
  }

  const result = yield* Stacks.apply(snapshot).pipe(
    renderApply(snapshot.native, display),
    // The dashboard tab must see the final verdict before the server goes
    // away: on failure too, give the SSE stream a beat to flush before the
    // error propagates and the CLI tears down.
    dashboard !== undefined
      ? Effect.onExit(() => Dashboard.stopDashboard(dashboard))
      : (effect) => effect,
  );
  if (result !== undefined) {
    const kit = yield* CliKit.CliKit;
    yield* kit.output.print(stackOutputsView(result));
  }
});

/**
 * Ask for approval of a plan with changes. With a dashboard attached
 * (`--ui`) the decision is delegated to the browser — the dashboard shows
 * the plan with an approve/reject choice and the terminal just points at
 * it — falling back to the terminal prompt whenever the dashboard cannot
 * be reached. Without one, the terminal prompt decides; a non-interactive
 * terminal declines with a `--yes` hint.
 */
const approvePlan = Effect.fn(function* (
  snapshot: Stacks.PlanSnapshot,
  options: {
    readonly operation: string;
    readonly display: { detailed?: boolean; stage?: string };
    readonly dashboardUrl?: string;
  },
) {
  const cli = yield* Cli;
  if (options.dashboardUrl !== undefined) {
    yield* CliKit.accessors.output.info(
      `Review and approve the plan in the dashboard: ${options.dashboardUrl}`,
    );
    const decision = yield* Dashboard.requestApprovalViaDashboard(
      options.dashboardUrl,
      snapshot.native,
    );
    if (decision !== undefined) {
      if (!decision) {
        yield* CliKit.accessors.output.info(
          `${options.operation} aborted: plan rejected in the dashboard.`,
        );
      }
      return decision;
    }
    yield* CliKit.accessors.output.warning(
      "Dashboard approval unreachable — falling back to terminal approval.",
    );
  }
  return yield* cli.approvePlan(snapshot.native, options.display).pipe(
    Effect.tap((approved) =>
      approved
        ? Effect.void
        : CliKit.accessors.output.info(
            `${options.operation} aborted: plan declined.`,
          ),
    ),
    Effect.catchTag("NonInteractiveTerminal", () =>
      CliKit.accessors.output
        .warning(
          `Cannot prompt for approval in a non-interactive terminal. Nothing was changed — re-run with --yes to ${options.operation.toLowerCase()}.`,
        )
        .pipe(Effect.as(false)),
    ),
  );
});

export const deployCommand = Command.make(
  "deploy",
  {
    dryRun: dryRunFlag,
    force,
    config: optionalConfig,
    configPath,
    envFile,
    stage,
    yes,
    profile,
    adopt,
    detailed,
    detectDrift,
    ui,
  },
  (args) =>
    resolveStackArgs("live")(args).pipe(
      Effect.flatMap(instrumentCommand("deploy", stackSpanAttrs)(runStack)),
    ),
);

export const destroyCommand = Command.make(
  "destroy",
  {
    dryRun: dryRunFlag,
    config: optionalConfig,
    configPath,
    envFile,
    stage,
    yes,
    profile,
    ui,
  },
  (args) =>
    resolveStackArgs("live")(args).pipe(
      Effect.flatMap(
        instrumentCommand(
          "destroy",
          stackSpanAttrs,
        )((options) =>
          runStack({
            ...options,
            destroy: true,
          }),
        ),
      ),
    ),
);

export const planCommand = Command.make(
  "plan",
  {
    config: optionalConfig,
    configPath,
    envFile,
    stage,
    profile,
    detailed,
    ui,
  },
  (args) =>
    resolveStackArgs("live")(args).pipe(
      Effect.flatMap(
        instrumentCommand(
          "plan",
          stackSpanAttrs,
        )((options) =>
          runStack({
            ...options,
            // plan is the same as deploy with dryRun always set to true
            dryRun: true,
          }),
        ),
      ),
    ),
);
