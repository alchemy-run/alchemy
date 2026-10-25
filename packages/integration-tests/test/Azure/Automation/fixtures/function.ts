import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/**
 * The subscription allows one Automation account per region, and a deleted
 * account keeps counting for 30 days unless it is recovered. The other
 * Automation suites use eastus2 and westus, so the bindings suite has its
 * own fixed group and account in northeurope (the provider recovers it from
 * soft-delete on each run).
 */
export const BINDINGS = {
  resourceGroup: "alchemy-test-automation-bindings",
  account: "alchemy-bindings-a1",
  location: "northeurope",
} as const;

/** Name of the PowerShell Workflow runbook; its workflow must carry the same name. */
export const WORKFLOW_RUNBOOK = "BindingsWorkflow";

export const Group = Azure.Resources.ResourceGroup("AutomationBindingsGroup", {
  name: BINDINGS.resourceGroup,
  location: BINDINGS.location,
});

export const Account = Effect.gen(function* () {
  const group = yield* Group;
  return yield* Azure.Automation.AutomationAccount("AutomationBindingsAccount", {
    resourceGroup: group.resourceGroupName,
    name: BINDINGS.account,
    location: BINDINGS.location,
    // A recovered account keeps the settings of its last life, so pin them.
    publicNetworkAccess: true,
    disableLocalAuth: false,
  });
});

const where = Effect.gen(function* () {
  const account = yield* Account;
  return { resourceGroup: account.resourceGroup, automationAccount: account.automationAccountName };
});

/** A PowerShell 7.2 runbook that sleeps for 10 minutes; tests stop its jobs. */
export const Sleeper = Effect.gen(function* () {
  const at = yield* where;
  return yield* Azure.Automation.Runbook("AutomationBindingsSleeper", {
    ...at,
    runbookType: "PowerShell72",
    content: "Start-Sleep -Seconds 600",
  });
});

/**
 * A PowerShell Workflow runbook that checkpoints every 10 seconds for 10
 * minutes: only workflow and graphical runbook jobs can be suspended, and
 * they suspend at a checkpoint.
 */
export const Checkpointer = Effect.gen(function* () {
  const at = yield* where;
  return yield* Azure.Automation.Runbook("AutomationBindingsWorkflow", {
    ...at,
    name: WORKFLOW_RUNBOOK,
    runbookType: "PowerShellWorkflow",
    content: `workflow ${WORKFLOW_RUNBOOK} {\n  foreach ($i in 1..60) {\n    Start-Sleep -Seconds 10\n    Checkpoint-Workflow\n  }\n}`,
  });
});

/** The watcher task's script: a PowerShell 5.1 runbook, as watchers run on Windows hybrid workers. */
const WatchScript = Effect.gen(function* () {
  const at = yield* where;
  return yield* Azure.Automation.Runbook("AutomationBindingsWatchScript", {
    ...at,
    runbookType: "PowerShell",
    content: 'Write-Output "watching"',
  });
});

/** Watchers only run on hybrid workers; an empty group is enough to hold them. */
const Workers = Effect.gen(function* () {
  const at = yield* where;
  return yield* Azure.Automation.HybridRunbookWorkerGroup("AutomationBindingsWorkers", at);
});

const watcher = (id: string) =>
  Effect.gen(function* () {
    const runbook = yield* WatchScript;
    const workers = yield* Workers;
    const at = yield* where;
    return yield* Azure.Automation.Watcher(id, {
      ...at,
      scriptName: runbook.runbookName,
      scriptRunOn: workers.hybridRunbookWorkerGroupName,
      executionFrequencyInSeconds: 300,
    });
  });

/** Started by `StartWatcher`. */
export const StartedWatcher = watcher("AutomationBindingsStartedWatcher");
/** Started out of band, then stopped by `StopWatcher`. */
export const StoppedWatcher = watcher("AutomationBindingsStoppedWatcher");

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Automation runtime-action
 * binding on a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the ARM
 * error.
 */
export default class AutomationFunction extends Azure.Functions.Function<AutomationFunction>()(
  "AutomationFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* Account;
    const sleeper = yield* Sleeper;
    const started = yield* StartedWatcher;
    const stopped = yield* StoppedWatcher;

    const startRunbook = yield* Azure.Automation.StartRunbook(sleeper);
    const getJob = yield* Azure.Automation.GetJob(account);
    const stopJob = yield* Azure.Automation.StopJob(account);
    const suspendJob = yield* Azure.Automation.SuspendJob(account);
    const resumeJob = yield* Azure.Automation.ResumeJob(account);
    const startWatcher = yield* Azure.Automation.StartWatcher(started);
    const stopWatcher = yield* Azure.Automation.StopWatcher(stopped);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const jobName = url.searchParams.get("job") ?? "";
        switch (url.pathname) {
          case "/start-runbook":
            return yield* respond(
              Effect.map(startRunbook({ jobName }), (job) => ({
                runbook: job.properties?.runbook?.name,
              })),
            );
          case "/get-job":
            return yield* respond(
              Effect.map(getJob({ jobName }), (job) => ({
                runbook: job.properties?.runbook?.name,
              })),
            );
          case "/stop-job":
            return yield* respond(Effect.as(stopJob({ jobName }), "stopped"));
          case "/suspend-job":
            return yield* respond(Effect.as(suspendJob({ jobName }), "suspended"));
          case "/resume-job":
            return yield* respond(Effect.as(resumeJob({ jobName }), "resumed"));
          case "/start-watcher":
            return yield* respond(Effect.as(startWatcher(), "started"));
          case "/stop-watcher":
            return yield* respond(Effect.as(stopWatcher(), "stopped"));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Automation.StartRunbookHttp,
        Azure.Automation.GetJobHttp,
        Azure.Automation.StopJobHttp,
        Azure.Automation.SuspendJobHttp,
        Azure.Automation.ResumeJobHttp,
        Azure.Automation.StartWatcherHttp,
        Azure.Automation.StopWatcherHttp,
      ),
    ),
  ),
) {}
