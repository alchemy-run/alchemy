import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { AdoptPolicy } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { apply } from "../../Apply.ts";
import { ArtifactStore, createArtifactStore } from "../../Artifacts.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CLI from "../../Cli/Cli.ts";
import * as Discovery from "../../Dashboard/Discovery.ts";
import * as Dashboard from "../../Dashboard/Launch.ts";
import * as Plan from "../../Plan.ts";
import { Stage } from "../../Stage.ts";
import * as Clank from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  dryRun as dryRunFlag,
  envFile,
  force,
  importStack,
  instrumentCommand,
  profile,
  script,
  stage,
  yes,
} from "./_shared.ts";

export const ExecStackOptions = Schema.Struct({
  main: Schema.String,
  stage: Schema.String,
  envFile: Schema.OptionFromOptional(Schema.String),
  profile: Schema.optional(Schema.String),
  dryRun: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
  yes: Schema.optional(Schema.Boolean),
  destroy: Schema.optional(Schema.Boolean),
  dev: Schema.optional(Schema.Boolean),
  adopt: Schema.optional(Schema.Boolean),
  ui: Schema.optional(Schema.Boolean),
});
export type ExecStackOptions = typeof ExecStackOptions.Type;
export type ExecStackOptionsEncoded = typeof ExecStackOptions.Encoded;

const stackSpanAttrs = (args: ExecStackOptions) => ({
  "alchemy.stage": args.stage,
  "alchemy.profile": args.profile,
  "alchemy.main": args.main,
  "alchemy.dry_run": !!args.dryRun,
  "alchemy.force": !!args.force,
  "alchemy.destroy": !!args.destroy,
  "alchemy.dev": !!args.dev,
  "alchemy.adopt": !!args.adopt,
  "alchemy.ui": !!args.ui,
});

/**
 * Clean user-facing message for a deploy blocked by the deployment lease:
 * who holds it, since when, and that it self-heals if the holder died.
 */
const formatDeploymentInProgress = (error: {
  stack: string;
  stage: string;
  holder: {
    version: number;
    startedAt: number;
    meta: {
      command: string;
      initiator?: { user?: string; host?: string; pid?: number };
    };
  };
}): string => {
  const { holder } = error;
  const who = [holder.meta.initiator?.user, holder.meta.initiator?.host]
    .filter((part): part is string => !!part)
    .join("@");
  const pid = holder.meta.initiator?.pid;
  return [
    `Another ${holder.meta.command} of ${error.stack}/${error.stage} is already in progress (deployment v${holder.version}).`,
    `  started: ${new Date(holder.startedAt).toISOString()}${who ? `  by: ${who}` : ""}${pid !== undefined ? ` (pid ${pid})` : ""}`,
    "  If that run died, its lease expires automatically ~60s after its last heartbeat — try again shortly.",
  ].join("\n");
};

const adopt = Flag.boolean("adopt").pipe(
  Flag.withDescription(
    "Adopt pre-existing cloud resources that conflict with this stack instead of failing. " +
      "Useful for re-importing infrastructure into a fresh state store.",
  ),
  Flag.withDefault(false),
);

const ui = Flag.boolean("ui").pipe(
  Flag.withDescription(
    "Open the alchemy dashboard and stream this run into it. Requires the " +
      "optional @alchemy.run/dashboard package.",
  ),
  Flag.withDefault(false),
);

export const execStack = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  dryRun = false,
  force = false,
  yes = false,
  destroy = false,
  dev = false,
  adopt = false,
  ui = false,
}: ExecStackOptions) {
  const stackEffect = yield* importStack(main);

  // --ui: make sure the dashboard is up before any planning so the run
  // streams into it from the first event (via the DashboardReporter tee).
  // Reuse an already-running dashboard for this project; otherwise launch
  // one in-process on the project's STABLE port (deterministic from
  // cwd+stack) so a browser tab from the previous run reconnects to the
  // same origin instead of a new tab opening every run. Fails fast (with
  // install instructions) when the optional @alchemy.run/dashboard peer is
  // missing — before any cloud interaction.
  let dashboardUrl: string | undefined;
  let launchedDashboard = false;
  let dashboardFiber: Fiber.Fiber<void, never> | undefined;
  if (ui) {
    yield* Dashboard.requireDistDir();
    // Opening is always safe: the SPA runs a same-origin BroadcastChannel
    // takeover, so the freshly opened tab supersedes (closes) any older
    // dashboard tab — the OS focuses the browser natively, no duplicate
    // tabs accumulate, and no browser automation is needed.
    const existing = yield* Discovery.discover().pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (existing !== undefined) {
      dashboardUrl = existing.url;
      yield* Clank.openUrl(existing.url).pipe(Effect.catch(() => Effect.void));
    } else {
      let port = Discovery.stablePort(stackEffect.stackName);
      const probe = yield* Discovery.probePort(port, stackEffect.stackName);
      if (probe.kind === "ours") {
        // a dashboard from a previous run is still serving (its
        // advertisement was lost) — reuse it rather than failing to bind
        dashboardUrl = probe.url;
        yield* Clank.openUrl(probe.url).pipe(Effect.catch(() => Effect.void));
      } else {
        if (probe.kind === "foreign") {
          // something else owns the stable port — fall back to a random one
          port = 0;
        }
        const ready = yield* Deferred.make<string>();
        dashboardFiber = yield* Effect.forkScoped(
          Dashboard.launchDashboard({
            stackEffect,
            stage,
            envFile,
            profile: profile ?? "default",
            port,
            open: true,
            ready,
          }).pipe(
            Effect.catchCause((cause) =>
              Console.error(`dashboard failed:\n${Cause.pretty(cause)}`),
            ),
          ),
        );
        dashboardUrl = yield* Deferred.await(ready).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.orElseSucceed(() => undefined),
        );
        if (dashboardUrl === undefined) {
          yield* Console.error(
            "dashboard did not start in time; continuing without --ui",
          );
        } else {
          launchedDashboard = true;
        }
      }
    }
  }

  const services = Layer.mergeAll(
    Layer.effect(
      AlchemyContext,
      AlchemyContext.pipe(
        Effect.map((ctx) => ({
          ...ctx,
          dev,
          adopt,
          // `--yes` also auto-accepts (and performs) an out-of-date state
          // store upgrade, instead of prompting.
          updateStateStore: yes,
        })),
      ),
    ),
    // `--adopt` opts the entire deploy in to adoption-on-conflict.
    // Resource providers that wire `AdoptPolicy` (Worker domains,
    // Cloudflare.SecretsStore, etc.) will reconcile against
    // pre-existing cloud resources instead of failing on duplicates.
    // Default is `false` so an unintentional collision still surfaces
    // loudly.
    Layer.succeed(AdoptPolicy, adopt),
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
              actions: {},
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
          // --ui delegates approval to the browser: the dashboard shows the
          // plan with an approve/reject choice and the terminal just points
          // at it. Falls back to the terminal prompt if the dashboard can't
          // be reached.
          let approved: boolean | undefined;
          if (ui && dashboardUrl !== undefined) {
            yield* Console.log(
              `Review and approve the plan in the dashboard: ${dashboardUrl}`,
            );
            approved = yield* Dashboard.requestApprovalViaDashboard(
              dashboardUrl,
              updatePlan,
            );
            if (approved === false) {
              yield* Console.log("Plan rejected in the dashboard.");
            }
          }
          if (approved === undefined) {
            if (ui && dashboardUrl !== undefined) {
              yield* Console.warn(
                "dashboard approval unreachable — falling back to terminal approval",
              );
            }
            approved = yield* cli.approvePlan(updatePlan);
          }
          if (!approved) {
            return;
          }
        }
        // In dev, a failed apply must not drain the keep-alive below:
        // `alchemy dev` runs under `bun --watch`, which cancels watch mode
        // entirely on a clean exit (oven-sh/bun#10983), so completing here
        // would tear down every healthy local resource along with the failed
        // one. Swallow apply failures (logging the full cause, since the TUI
        // renderer only shows the failure status) so the keep-alive engages
        // and the rest of the stack keeps serving, but re-propagate a pure
        // interruption (Ctrl-C / fiber kill) so dev still shuts down cleanly.
        // A concurrent deploy of the same stack/stage holds the deployment
        // lease — surface who/since-when cleanly instead of a raw cause, and
        // do NOT retry (the lease auto-expires ~60s after the holder's last
        // heartbeat if it died).
        const applyStack = apply(updatePlan, {
          command: destroy ? "destroy" : "deploy",
        }).pipe(
          Effect.catchTag("DeploymentInProgress", (error) =>
            Console.error(formatDeploymentInProgress(error)).pipe(
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        const applyPlan = dev
          ? applyStack.pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Console.error(
                      `alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.\n${Cause.pretty(cause)}`,
                    ).pipe(Effect.as(undefined)),
              ),
            )
          : applyStack;
        const applyExit = yield* Effect.exit(applyPlan);
        if (Exit.isFailure(applyExit)) {
          if (ui && !dev && launchedDashboard) {
            // give the dashboard a beat to flush the failure verdict to
            // the tab before teardown ends the SSE streams
            yield* Effect.sleep(Duration.seconds(2));
          }
          return yield* Effect.failCause(applyExit.cause);
        }
        const outputs = applyExit.value;

        if (outputs !== undefined) {
          yield* Console.log(outputs);
        }

        if (dev) {
          return yield* Effect.never;
        }
      }
    }).pipe(Effect.provide(stack.services));

    // `plan --ui` exists to LOOK at the plan — keep serving until Ctrl+C.
    // deploy/destroy exit when the run settles: give the SSE stream a beat
    // to flush the final patch frames, stop the dashboard fiber so its
    // finalizers run (advertisement cleanup, SSE latch), then exit
    // EXPLICITLY: runMain only force-exits on failure or signal, and the
    // Bun server handle (whose graceful stop can wait forever on the
    // browser's idle keep-alive connections) would otherwise keep the
    // event loop alive indefinitely.
    if (ui && !dev && dashboardUrl !== undefined) {
      if (dryRun) {
        yield* Console.log(
          `\ndashboard serving at ${dashboardUrl} — press Ctrl+C to exit`,
        );
        yield* Effect.never;
      } else if (launchedDashboard) {
        yield* Effect.sleep(Duration.seconds(2));
        yield* Console.log(
          "\ndashboard stopped — the tab reconnects on the next --ui run",
        );
        if (dashboardFiber !== undefined) {
          yield* Fiber.interrupt(dashboardFiber).pipe(
            Effect.timeout(Duration.seconds(3)),
            Effect.ignore,
          );
        }
        yield* Effect.sync(() => process.exit(0));
      }
    }
  }).pipe(Effect.provide(services));
});

export const deployCommand = Command.make(
  "deploy",
  {
    dryRun: dryRunFlag,
    force,
    main: script,
    envFile,
    stage,
    yes,
    profile,
    adopt,
    ui,
  },
  instrumentCommand("deploy", stackSpanAttrs)(execStack),
);

export const destroyCommand = Command.make(
  "destroy",
  {
    dryRun: dryRunFlag,
    main: script,
    envFile,
    stage,
    yes,
    profile,
    ui,
  },
  instrumentCommand(
    "destroy",
    stackSpanAttrs,
  )((args) =>
    execStack({
      ...args,
      destroy: true,
    }),
  ),
);

export const planCommand = Command.make(
  "plan",
  {
    main: script,
    envFile,
    stage,
    profile,
    ui,
  },
  instrumentCommand(
    "plan",
    stackSpanAttrs,
  )((args) =>
    execStack({
      ...args,
      // plan is the same as deploy with dryRun always set to true
      dryRun: true,
    }),
  ),
);
