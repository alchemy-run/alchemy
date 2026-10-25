import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as automation from "@distilled.cloud/azure/automation";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import AutomationFunction, {
  Account,
  BINDINGS,
  Checkpointer,
  Sleeper,
  StartedWatcher,
  StoppedWatcher,
  WORKFLOW_RUNBOOK,
} from "./fixtures/function.ts";
import { tags } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureAutomationBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AutomationFunction;
    const account = yield* Account;
    const sleeper = yield* Sleeper;
    yield* Checkpointer;
    const started = yield* StartedWatcher;
    const stopped = yield* StoppedWatcher;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      accountId: account.automationAccountId,
      sleeper: sleeper.runbookName,
      started: started.watcherName,
      startedId: started.watcherId,
      stopped: stopped.watcherName,
      stoppedId: stopped.watcherId,
    };
  }),
);

// Automation is free up to 500 job minutes a month; the jobs here are
// stopped within minutes. Plus a Flex Consumption app (~$0.01/run); ~5 min
// deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its ARM error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The bindings account's path parameters. */
const inAccount = Effect.map(Azure.AzureEnvironment.current, ({ subscriptionId }) => ({
  subscriptionId,
  resourceGroupName: BINDINGS.resourceGroup,
  automationAccountName: BINDINGS.account,
}));

/** Job names are runtime data (a GUID each), not resource names. */
const newJobName = Effect.sync(() => crypto.randomUUID());

/** Start a job of `runbook` with the deployer's credentials. */
const seedJob = (runbook: string) =>
  Effect.gen(function* () {
    const at = yield* inAccount;
    const jobName = yield* newJobName;
    yield* automation.CreateJob({ ...at, jobName, properties: { runbook: { name: runbook } } });
    return jobName;
  }).pipe(Effect.provide(azure));

const observeJob = (jobName: string) =>
  Effect.gen(function* () {
    const at = yield* inAccount;
    return yield* automation.GetJob({ ...at, jobName });
  }).pipe(Effect.provide(azure));

/** Poll a job until its status is one of `statuses`. */
const untilJobStatus = (jobName: string, statuses: readonly string[], times = 36) =>
  observeJob(jobName).pipe(
    Effect.map((job) => job.properties?.status as string | undefined),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => statuses.includes(status ?? ""),
      times,
    }),
  );

/** Stop a job the test started, so it stops spending job minutes. */
const cleanupJob = (jobName: string) =>
  Effect.gen(function* () {
    const at = yield* inAccount;
    yield* automation.StopJob({ ...at, jobName }).pipe(Effect.ignore);
  }).pipe(Effect.provide(azure));

const observeWatcher = (watcherName: string) =>
  Effect.gen(function* () {
    const at = yield* inAccount;
    const watcher = yield* automation.GetWatcher({ ...at, watcherName });
    return watcher.properties?.status;
  }).pipe(Effect.provide(azure));

const untilWatcherStatus = (watcherName: string, status: string) =>
  observeWatcher(watcherName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (observed) => observed === status,
      times: 24,
    }),
  );

/** Every role on the Function's identity as `<actions> <scope>`, without its host-storage grants. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    const grants: string[] = [];
    for (const assignment of assignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      if (scope.endsWith(host)) continue;
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  }).pipe(Effect.provide(azure));

describe("Azure Automation bindings on an Azure Function", { tags }, () => {
  test(
    "each binding grants exactly its action on the account or watcher",
    Effect.gen(function* () {
      const { principalId, hostStorageAccount, accountId, startedId, stoppedId } = yield* stack;
      const jobs = "Microsoft.Automation/automationAccounts/jobs";
      const watchers = "Microsoft.Automation/automationAccounts/watchers";
      const expected = [
        `${jobs}/write ${accountId.toLowerCase()}`,
        `${jobs}/read ${accountId.toLowerCase()}`,
        `${jobs}/stop/action ${accountId.toLowerCase()}`,
        `${jobs}/suspend/action ${accountId.toLowerCase()}`,
        `${jobs}/resume/action ${accountId.toLowerCase()}`,
        `${watchers}/start/action ${startedId.toLowerCase()}`,
        `${watchers}/stop/action ${stoppedId.toLowerCase()}`,
      ].sort();
      // Role-assignment lists trail the deploy by a few seconds.
      const grants = yield* grantsOf(principalId ?? "", hostStorageAccount).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (grants) => grants.length >= expected.length,
          times: 24,
        }),
      );
      expect(grants).toEqual(expected);
    }),
    { timeout: 600_000 },
  );

  describe("Automation.StartRunbook", () => {
    test(
      "starts a job of the bound runbook",
      Effect.gen(function* () {
        const { sleeper } = yield* stack;
        const jobName = yield* newJobName;
        const body = yield* call(`/start-runbook?job=${jobName}`);
        expectOk(body);
        expect(body.result).toEqual({ runbook: sleeper });
        const job = yield* observeJob(jobName);
        expect(job.properties?.runbook?.name).toEqual(sleeper);
        yield* cleanupJob(jobName);
      }),
      { timeout: 600_000 },
    );
  });

  describe("Automation.GetJob", () => {
    test(
      "reads a job the deployer started",
      Effect.gen(function* () {
        const { sleeper } = yield* stack;
        const jobName = yield* seedJob(sleeper);
        const body = yield* call(`/get-job?job=${jobName}`);
        yield* cleanupJob(jobName);
        expectOk(body);
        expect(body.result).toEqual({ runbook: sleeper });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Automation.StopJob", () => {
    test(
      "stops a job the deployer started",
      Effect.gen(function* () {
        const { sleeper } = yield* stack;
        const jobName = yield* seedJob(sleeper);
        const body = yield* call(`/stop-job?job=${jobName}`);
        expectOk(body);
        expect(yield* untilJobStatus(jobName, ["Stopped"])).toEqual("Stopped");
      }),
      { timeout: 600_000 },
    );
  });

  describe("Automation.SuspendJob and Automation.ResumeJob", () => {
    test(
      "suspends a running workflow job, then resumes it",
      Effect.gen(function* () {
        const jobName = yield* seedJob(WORKFLOW_RUNBOOK);
        // A cloud job waits for a sandbox for up to a few minutes.
        expect(yield* untilJobStatus(jobName, ["Running"])).toEqual("Running");
        const suspended = yield* call(`/suspend-job?job=${jobName}`);
        expectOk(suspended);
        expect(yield* untilJobStatus(jobName, ["Suspended"])).toEqual("Suspended");
        const resumed = yield* call(`/resume-job?job=${jobName}`);
        expectOk(resumed);
        expect(yield* untilJobStatus(jobName, ["Running"])).toEqual("Running");
        yield* cleanupJob(jobName);
      }),
      { timeout: 900_000 },
    );
  });

  // Watcher tasks run only on a Windows hybrid worker with the Hybrid
  // Worker agent installed; on the fixture's empty worker group both calls
  // reach Azure with the binding's role and fail.
  describe("Automation.StartWatcher", () => {
    // Skipped: BadRequest: Cannot resume a job that is not in suspended state.
    test.skip(
      "starts the bound watcher",
      Effect.gen(function* () {
        const { started } = yield* stack;
        const body = yield* call("/start-watcher");
        expectOk(body);
        expect(yield* untilWatcherStatus(started, "Running")).toEqual("Running");
      }),
      { timeout: 600_000 },
    );
  });

  describe("Automation.StopWatcher", () => {
    // Skipped: the deployer's StartWatcher fails with BadRequest: Cannot
    // resume a job that is not in suspended state.
    test.skip(
      "stops the bound watcher after the deployer starts it",
      Effect.gen(function* () {
        const { stopped } = yield* stack;
        const at = yield* inAccount.pipe(Effect.provide(azure));
        yield* automation.StartWatcher({ ...at, watcherName: stopped }).pipe(Effect.provide(azure));
        expect(yield* untilWatcherStatus(stopped, "Running")).toEqual("Running");
        const body = yield* call("/stop-watcher");
        expectOk(body);
        expect(yield* untilWatcherStatus(stopped, "Stopped")).toEqual("Stopped");
      }),
      { timeout: 600_000 },
    );
  });
});
