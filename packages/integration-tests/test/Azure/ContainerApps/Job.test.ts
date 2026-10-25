import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive, withManagedEnvironment } from "../gates.ts";
import EffectJob from "./fixtures/effect-job.ts";
import { QueueJob, SCHEDULE, ScheduleJob, ServiceBusJob } from "./fixtures/event-jobs.ts";
import { AsyncJob, JOB_LOCATION, JobData, JobEnv, JobResults } from "./fixtures/job-resources.ts";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  QUICKSTART_JOB_IMAGE,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";

const LOCATION = STANDARD_LOCATION;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const where = (resourceGroupName: string, jobName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, jobName };
  });

const getJob = (resourceGroupName: string, jobName: string) =>
  where(resourceGroupName, jobName).pipe(Effect.flatMap(app.GetJob));

const program = (
  trigger: { triggerType: "Manual" } | { triggerType: "Schedule"; cronExpression: string },
  tags: Record<string, string>,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const job = yield* Azure.ContainerApps.Job("Job", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentId: env.environmentId,
      configuration:
        trigger.triggerType === "Manual"
          ? {
              triggerType: "Manual",
              replicaTimeout: 120,
              replicaRetryLimit: 0,
              manualTriggerConfig: {
                parallelism: 1,
                replicaCompletionCount: 1,
              },
            }
          : {
              triggerType: "Schedule",
              replicaTimeout: 120,
              replicaRetryLimit: 0,
              scheduleTriggerConfig: {
                cronExpression: trigger.cronExpression,
                parallelism: 1,
                replicaCompletionCount: 1,
              },
            },
      template: {
        containers: [
          {
            name: "main",
            image: QUICKSTART_JOB_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
          },
        ],
      },
      tags,
    });
    return { group, env, job };
  });

// Cost: Consumption environment (free idle) + one 0.25 vCPU execution of a
// few seconds, inside the monthly free grant (~$0).
// Gated (time, not cost): the trial allows one standard environment per
// subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, run, update, and delete a container apps job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, job } = yield* stack.deploy(
        program({ triggerType: "Manual" }, { env: "test" }),
      );
      expect(job.jobName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(job.triggerType).toEqual("Manual");

      const observed = yield* getJob(group.resourceGroupName, job.jobName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.configuration?.replicaTimeout).toEqual(120);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Job");

      // Start an execution out-of-band and wait for it to complete.
      const execution = yield* where(group.resourceGroupName, job.jobName).pipe(
        Effect.flatMap(app.StartJob),
      );
      expect(execution.name).toMatch(new RegExp(`^${job.jobName}-[a-z0-9]+$`));
      const finished = yield* where(group.resourceGroupName, job.jobName).pipe(
        Effect.flatMap(app.ListJobsExecutions),
        Effect.map((page) => page.value.find((e) => e.name === execution.name)),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (e) => e?.properties?.status === "Succeeded" || e?.properties?.status === "Failed",
          times: 24,
        }),
      );
      expect(finished?.properties?.status).toEqual("Succeeded");

      // In-place update: switch to a schedule trigger and change tags.
      const updated = yield* stack.deploy(
        program({ triggerType: "Schedule", cronExpression: "0 3 * * *" }, { env: "prod" }),
      );
      expect(updated.job.jobId).toEqual(job.jobId);
      expect(updated.job.triggerType).toEqual("Schedule");
      const reobserved = yield* getJob(group.resourceGroupName, job.jobName);
      expect(reobserved.properties?.configuration?.scheduleTriggerConfig?.cronExpression).toEqual(
        "0 3 * * *",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(getJob(group.resourceGroupName, job.jobName))).toEqual("gone");
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);

// ---------------------------------------------------------------------------
// Runtime: Effect and async jobs built from `main`, their bindings, event
// sources, and schedule, all in one shared environment.
// ---------------------------------------------------------------------------

const RuntimeStack = Alchemy.Stack(
  "AzureContainerAppsJobRuntime",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const effectJob = yield* EffectJob;
    const asyncJob = yield* AsyncJob;
    const queueJob = yield* QueueJob;
    const serviceBusJob = yield* ServiceBusJob;
    const scheduleJob = yield* ScheduleJob;
    const account = yield* JobData;
    const results = yield* JobResults;
    const env = yield* JobEnv;
    return {
      environmentId: env.environmentId,
      resourceGroup: effectJob.resourceGroup,
      effectJob: effectJob.jobName,
      effectPrincipalId: effectJob.principalId,
      effectImage: effectJob.image,
      asyncJob: asyncJob.jobName,
      queueJob: queueJob.jobName,
      queueTrigger: queueJob.triggerType,
      serviceBusJob: serviceBusJob.jobName,
      serviceBusTrigger: serviceBusJob.triggerType,
      scheduleJob: scheduleJob.jobName,
      scheduleTrigger: scheduleJob.triggerType,
      account: account.storageAccountName,
      accountGroup: account.resourceGroup,
      container: results.containerName,
    };
  }),
);

// One standard environment (free idle; 5-30 min to create, 5-25 min to
// delete), a Standard Service Bus namespace (~$0.01/h), two Basic registries
// (~$0.17/day each), and a few 0.25 vCPU executions (inside the free
// grant): ~$0.10/run, ~15-60 min.
const runtime = beforeAll(deploy(RuntimeStack).pipe(withManagedEnvironment), {
  timeout: 3_000_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(RuntimeStack), { timeout: 2_400_000 });

const runtimeTest = { tags: ["provider:azure", "provider:azure:containerapps", "live"] };

class ExecutionPending extends Data.TaggedError("ExecutionPending")<{
  execution: string;
  status: string | undefined;
}> {}

class ResultPending extends Data.TaggedError("ResultPending")<{ key: string }> {}

/** Executions of `jobName` (first page: the newest). */
const executionsOf = (resourceGroupName: string, jobName: string) =>
  where(resourceGroupName, jobName).pipe(
    Effect.flatMap(app.ListJobsExecutions),
    Effect.map((page) => page.value),
  );

/** Start `jobName` out of band; returns the execution name. */
const startExecution = (resourceGroupName: string, jobName: string) =>
  where(resourceGroupName, jobName).pipe(
    Effect.flatMap(app.StartJob),
    Effect.map((execution) => execution.name ?? ""),
  );

/** Wait until `execution` finishes (10 minutes at most); returns its status. */
const awaitExecution = (resourceGroupName: string, jobName: string, execution: string) =>
  executionsOf(resourceGroupName, jobName).pipe(
    Effect.map((executions) => executions.find((e) => e.name === execution)?.properties?.status),
    Effect.flatMap((status) =>
      status === "Succeeded" || status === "Failed" || status === "Stopped"
        ? Effect.succeed(status)
        : Effect.fail(new ExecutionPending({ execution, status })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ExecutionPending",
      schedule: Schedule.spaced("10 seconds"),
      times: 60,
    }),
  );

/**
 * Read `key` from the results container out of band, through a one-hour
 * service SAS (ARM `listServiceSas`), so the check never waits on a role.
 * Polls until the blob exists (5 minutes at most).
 */
const readResult = (key: string) =>
  Effect.gen(function* () {
    const out = yield* runtime;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const signedExpiry = yield* Effect.sync(() => new Date(Date.now() + 3_600_000).toISOString());
    const sas = yield* storage.ListStorageAccountServiceSAS({
      subscriptionId,
      resourceGroupName: out.accountGroup,
      accountName: out.account,
      canonicalizedResource: `/blob/${out.account}/${out.container}`,
      signedResource: "c",
      signedPermission: "rl",
      signedProtocol: "https",
      signedExpiry,
    });
    const read = blob
      .DownloadBlob({
        url: `https://${out.account}.blob.core.windows.net?${sas.serviceSasToken}`,
        containerName: out.container,
        blob: key,
      })
      .pipe(
        Effect.map((downloaded) => JSON.parse(new TextDecoder().decode(downloaded.body))),
        Effect.catchTag("BlobNotFound", () => Effect.fail(new ResultPending({ key }))),
      );
    return yield* read.pipe(
      Effect.retry({
        while: (e) => e._tag === "ResultPending",
        schedule: Schedule.spaced("10 seconds"),
        times: 30,
      }),
    );
  });

/** Role assignments held by `principalId`, as `scope|role` pairs. */
const roleAssignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    return page.value
      .map(
        (a) =>
          `${a.properties?.scope?.toLowerCase()}|${a.properties?.roleDefinitionId?.split("/").pop()}`,
      )
      .sort();
  });

/**
 * Run `EffectJob` once and wait for it. Its first execution can fail while
 * the identity's new data roles propagate, so a failed run is retried
 * (3 times at most). Returns the succeeded execution's name.
 */
const runEffectJob = Effect.gen(function* () {
  const out = yield* runtime;
  const execution = yield* startExecution(out.resourceGroup, out.effectJob);
  const status = yield* awaitExecution(out.resourceGroup, out.effectJob, execution);
  return status === "Succeeded"
    ? execution
    : yield* Effect.fail(new ExecutionPending({ execution, status }));
}).pipe(
  Effect.retry({
    while: (e) => e._tag === "ExecutionPending",
    schedule: Schedule.spaced("30 seconds"),
    times: 3,
  }),
);

// Sequential: the redeploy case changes the effect job's env.
describe.sequential("Container Apps job runtime", runtimeTest, () => {
  test.provider(
    "effect job runs its program and writes through its bindings",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        // Out of band: a manual job on the program image, pulled with its identity.
        const job = yield* getJob(out.resourceGroup, out.effectJob);
        expect(job.identity?.type).toEqual("SystemAssigned");
        expect(job.properties?.configuration?.triggerType).toEqual("Manual");
        const registry = job.properties?.configuration?.registries?.[0];
        expect(registry?.identity).toEqual("system");
        expect(job.properties?.template?.containers?.[0]?.image).toEqual(out.effectImage);
        expect(out.effectImage).toMatch(
          new RegExp(
            `^${registry?.server?.replaceAll(".", "\\.")}/alchemy/effectjob:[0-9a-f]{16}$`,
          ),
        );

        const execution = yield* runEffectJob;
        const report = (yield* readResult(`effect/${execution}`)) as {
          greeting: string;
          node: string;
        };
        expect(report.greeting).toEqual("hello");
        expect(report.node).toMatch(/^24\./);
      }),
    { ...runtimeTest, timeout: 1_200_000 },
  );

  test.provider(
    "async job receives literal, Config, secret, and resource env",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        // Out of band: the Redacted value is a job secret, referenced by name.
        const job = yield* getJob(out.resourceGroup, out.asyncJob);
        const env = job.properties?.template?.containers?.[0]?.env ?? [];
        expect(env.find((e) => e.name === "SECRET")).toEqual({
          name: "SECRET",
          secretRef: "env-secret",
        });
        expect(env.find((e) => e.name === "GREETING")?.value).toEqual("hello");

        // The handler throws (failing the execution) unless env decodes as declared.
        const execution = yield* startExecution(out.resourceGroup, out.asyncJob);
        expect(yield* awaitExecution(out.resourceGroup, out.asyncJob, execution)).toEqual(
          "Succeeded",
        );
      }),
    { ...runtimeTest, timeout: 900_000 },
  );

  test.provider(
    "container job updates in place and is replaced when its name changes",
    (stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        yield* stack.destroy();
        const containerJob = (name: string, replicaTimeout: number) =>
          Effect.gen(function* () {
            const job = yield* Azure.ContainerApps.Job("RawJob", {
              name,
              location: JOB_LOCATION,
              environmentId: out.environmentId,
              configuration: { triggerType: "Manual", replicaTimeout },
              template: {
                containers: [
                  {
                    name: "main",
                    image: QUICKSTART_JOB_IMAGE,
                    resources: { cpu: 0.25, memory: "0.5Gi" },
                  },
                ],
              },
              env: { MODE: "raw" },
            });
            return {
              jobName: job.jobName,
              jobId: job.jobId,
              resourceGroup: job.resourceGroup,
              image: job.image,
            };
          });

        const first = yield* stack.deploy(containerJob("alchemy-raw-job-a", 120));
        expect(first.jobName).toEqual("alchemy-raw-job-a");
        expect(first.image).toBeUndefined();
        const created = yield* getJob(first.resourceGroup, first.jobName);
        expect(created.identity?.type ?? "None").toEqual("None");
        expect(created.properties?.template?.containers?.[0]?.env).toEqual([
          { name: "MODE", value: "raw" },
        ]);

        // In place: a new timeout keeps the job.
        const updated = yield* stack.deploy(containerJob("alchemy-raw-job-a", 240));
        expect(updated.jobId).toEqual(first.jobId);
        const reobserved = yield* getJob(first.resourceGroup, first.jobName);
        expect(reobserved.properties?.configuration?.replicaTimeout).toEqual(240);

        // Replace: a new name creates a new job and deletes the old one.
        const renamed = yield* stack.deploy(containerJob("alchemy-raw-job-b", 240));
        expect(renamed.jobName).toEqual("alchemy-raw-job-b");
        expect(renamed.jobId).not.toEqual(first.jobId);
        expect(yield* waitGone(getJob(first.resourceGroup, first.jobName))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(getJob(renamed.resourceGroup, renamed.jobName))).toEqual("gone");
      }),
    { ...runtimeTest, timeout: 900_000 },
  );

  test.provider(
    "Storage.QueueEventSource starts the job for a queued message",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        expect(out.queueTrigger).toEqual("Event");
        const job = yield* getJob(out.resourceGroup, out.queueJob);
        const rule = job.properties?.configuration?.eventTriggerConfig?.scale?.rules?.[0];
        expect({ type: rule?.type, identity: rule?.identity }).toEqual({
          type: "azure-queue",
          identity: "system",
        });

        // `EffectJob` sends `{ id: <execution> }` to the queue.
        const execution = yield* runEffectJob;
        const recorded = (yield* readResult(`queue/${execution}`).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
        )) as { dequeueCount: number };
        expect(recorded.dequeueCount).toBeGreaterThanOrEqual(1);
      }),
    { ...runtimeTest, timeout: 1_800_000 },
  );

  test.provider(
    "ServiceBus.QueueEventSource starts the job for a sent message",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        expect(out.serviceBusTrigger).toEqual("Event");
        const execution = yield* runEffectJob;
        const recorded = (yield* readResult(`servicebus/${execution}`).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
        )) as { deliveryCount: number };
        expect(recorded.deliveryCount).toBeGreaterThanOrEqual(1);
      }),
    { ...runtimeTest, timeout: 1_800_000 },
  );

  test.provider(
    "ContainerApps.schedule runs the job on its cron schedule",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        expect(out.scheduleTrigger).toEqual("Schedule");
        const job = yield* getJob(out.resourceGroup, out.scheduleJob);
        expect(job.properties?.configuration?.scheduleTriggerConfig?.cronExpression).toEqual(
          SCHEDULE,
        );
        // Every minute: wait for a succeeded execution (10 minutes at most).
        const succeeded = yield* executionsOf(out.resourceGroup, out.scheduleJob).pipe(
          Effect.map((executions) => executions.find((e) => e.properties?.status === "Succeeded")),
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (e) => e !== undefined,
            times: 40,
          }),
        );
        expect(succeeded?.name).toMatch(new RegExp(`^${out.scheduleJob}-[a-z0-9]+$`));
        const recorded = (yield* readResult(`schedule/${succeeded?.name}`)) as { at: string };
        expect(Date.parse(recorded.at)).toBeGreaterThan(0);
      }),
    { ...runtimeTest, timeout: 900_000 },
  );

  test.provider(
    "redeploying the effect job keeps its role assignments",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        expect(out.effectPrincipalId).toMatch(/^[0-9a-f-]{36}$/);
        const before = yield* roleAssignmentsOf(out.effectPrincipalId!);
        // AcrPull + blob ReadWrite + queue send + Service Bus send.
        expect(before.length).toEqual(4);

        // A changed env value updates the job in place.
        const config = yield* ConfigProvider.ConfigProvider;
        const redeployed = yield* deploy(RuntimeStack).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromEnv({ env: { AZURE_JOB_EFFECT_GREETING: "hi" } }),
              config,
            ),
          ),
        );
        expect(redeployed.effectJob).toEqual(out.effectJob);
        expect(redeployed.effectPrincipalId).toEqual(out.effectPrincipalId);
        expect(yield* roleAssignmentsOf(out.effectPrincipalId!)).toEqual(before);

        // …and the program still runs with them, on the new env.
        const execution = yield* runEffectJob;
        const report = (yield* readResult(`effect/${execution}`)) as { greeting: string };
        expect(report.greeting).toEqual("hi");
      }),
    { ...runtimeTest, timeout: 1_800_000 },
  );
});
