import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as batch from "@distilled.cloud/azure/batch";
import * as data from "@distilled.cloud/azure/batch-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import BatchFunction, { Jobs, POOL_ID, RECURRENCE } from "./fixtures/function.ts";
import { tags, waitGone } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Azure Batch Data Contributor**: the deployer seeds and observes jobs. */
const AZURE_BATCH_DATA_CONTRIBUTOR = "6aaa78f1-f7de-44ca-8722-c64a23943cae";

/** Object ID (`oid` claim) of the identity running the tests. */
const deployerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureBatchBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* BatchFunction;
    const account = yield* Jobs;
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("BatchBindingsDeployer", {
      scope: account.accountId,
      roleDefinitionId: AZURE_BATCH_DATA_CONTRIBUTOR,
      principalId: deployer,
      principalType: "ServicePrincipal",
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      accountId: account.accountId,
      accountName: account.accountName,
      resourceGroup: account.resourceGroup,
      accountEndpoint: account.accountEndpoint,
    };
  }),
);

// The Batch account is free and runs no pool (its pool quota is 0); a Flex
// Consumption app (~$0.01/run); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its Batch error.
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

// --- out-of-band reads and writes (deployer credentials) ---

/** The deployer's data role can trail the deploy by a few minutes. */
const whileDenied = {
  while: (e: { readonly _tag: string }) => e._tag === "BatchPermissionDenied",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

const endpoint = Effect.map(stack, ({ accountEndpoint }) => `https://${accountEndpoint}`);

const seedJob = (jobId: string) =>
  Effect.gen(function* () {
    const url = yield* endpoint;
    yield* data
      .CreateJobJob({ endpoint: url, id: jobId, poolInfo: { poolId: POOL_ID } })
      .pipe(Effect.retry(whileDenied));
  }).pipe(Effect.provide(azure));

const seedTask = (jobId: string, taskId: string) =>
  Effect.gen(function* () {
    const url = yield* endpoint;
    yield* data
      .CreateTaskTask({ endpoint: url, jobId, id: taskId, commandLine: "/bin/sh -c 'echo seed'" })
      .pipe(Effect.retry(whileDenied));
  }).pipe(Effect.provide(azure));

const seedJobSchedule = (jobScheduleId: string) =>
  Effect.gen(function* () {
    const url = yield* endpoint;
    yield* data
      .CreateJobScheduleJobSchedule({
        endpoint: url,
        id: jobScheduleId,
        schedule: { recurrenceInterval: RECURRENCE },
        jobSpecification: { poolInfo: { poolId: POOL_ID } },
      })
      .pipe(Effect.retry(whileDenied));
  }).pipe(Effect.provide(azure));

const observeJob = (jobId: string) =>
  Effect.gen(function* () {
    const url = yield* endpoint;
    return yield* data.GetJobJob({ endpoint: url, jobId }).pipe(Effect.retry(whileDenied));
  }).pipe(Effect.provide(azure));

const observeTask = (jobId: string, taskId: string) =>
  Effect.gen(function* () {
    const url = yield* endpoint;
    return yield* data
      .GetTaskTask({ endpoint: url, jobId, taskId })
      .pipe(Effect.retry(whileDenied));
  }).pipe(Effect.provide(azure));

const observeJobSchedule = (jobScheduleId: string) =>
  Effect.gen(function* () {
    const url = yield* endpoint;
    return yield* data
      .GetJobScheduleJobSchedule({ endpoint: url, jobScheduleId })
      .pipe(Effect.retry(whileDenied));
  }).pipe(Effect.provide(azure));

/** Poll an observation (`"found"` or `"gone"`) until it reports `"gone"`. */
const untilGone = <E, R>(observe: Effect.Effect<"found" | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const jobGone = (jobId: string) =>
  untilGone(
    observeJob(jobId).pipe(
      Effect.as("found" as const),
      Effect.catchTag("BatchJobNotFound", () => Effect.succeed("gone" as const)),
    ),
  );

const taskGone = (jobId: string, taskId: string) =>
  untilGone(
    observeTask(jobId, taskId).pipe(
      Effect.as("found" as const),
      Effect.catchTag("BatchTaskNotFound", () => Effect.succeed("gone" as const)),
    ),
  );

const jobScheduleGone = (jobScheduleId: string) =>
  untilGone(
    observeJobSchedule(jobScheduleId).pipe(
      Effect.as("found" as const),
      Effect.catchTag("BatchJobScheduleNotFound", () => Effect.succeed("gone" as const)),
    ),
  );

/** Poll a job until it reaches `state`. */
const untilJobState = (jobId: string, state: string) =>
  observeJob(jobId).pipe(
    Effect.map((job) => job.state as string),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (observed) => observed === state,
      times: 24,
    }),
  );

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    return Array.from(assignments).filter(
      (a) => !(a.properties?.scope?.toLowerCase() ?? "").endsWith(host),
    );
  });

/** Every role on the Function's identity as `<actions + data actions> <scope>`. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId, hostStorageAccount)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
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
  });

describe("Azure Batch bindings on an Azure Function", { tags }, () => {
  describe("Batch.CreateJob", () => {
    test(
      "creates a job in the bound account",
      Effect.gen(function* () {
        const body = yield* call("/create-job?job=created-job");
        expectOk(body);
        expect(body.result).toEqual({ created: "created-job" });
        const job = yield* observeJob("created-job");
        expect({ state: job.state, poolId: job.poolInfo.poolId, priority: job.priority }).toEqual({
          state: "active",
          poolId: POOL_ID,
          priority: 7,
        });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.GetJob", () => {
    test(
      "reads a job the deployer created",
      Effect.gen(function* () {
        yield* seedJob("read-job");
        const body = yield* call("/get-job?job=read-job");
        expectOk(body);
        expect(body.result).toEqual({ id: "read-job", state: "active", priority: 0 });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.ListJobs", () => {
    test(
      "lists a job the deployer created",
      Effect.gen(function* () {
        yield* seedJob("listed-job");
        const body = yield* call("/list-jobs?job=listed-job");
        expectOk(body);
        expect(body.result).toEqual(["listed-job"]);
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.UpdateJob", () => {
    test(
      "raises a job's priority",
      Effect.gen(function* () {
        yield* seedJob("updated-job");
        const body = yield* call("/update-job?job=updated-job");
        expectOk(body);
        const job = yield* observeJob("updated-job");
        expect(job.priority).toEqual(100);
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.DeleteJob", () => {
    test(
      "deletes a job the deployer created",
      Effect.gen(function* () {
        yield* seedJob("deleted-job");
        const body = yield* call("/delete-job?job=deleted-job");
        expectOk(body);
        expect(yield* jobGone("deleted-job")).toEqual("gone");
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.TerminateJob", () => {
    test(
      "terminates a job the deployer created",
      Effect.gen(function* () {
        yield* seedJob("terminated-job");
        const body = yield* call("/terminate-job?job=terminated-job");
        expectOk(body);
        expect(yield* untilJobState("terminated-job", "completed")).toEqual("completed");
        const job = yield* observeJob("terminated-job");
        expect(job.executionInfo?.terminateReason).toEqual("binding-test");
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.GetJobTaskCounts", () => {
    test(
      "counts the tasks the deployer added",
      Effect.gen(function* () {
        yield* seedJob("counted-job");
        yield* seedTask("counted-job", "first");
        yield* seedTask("counted-job", "second");
        // Batch refreshes task counts every few seconds.
        const body = yield* call("/task-counts?job=counted-job").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (answer) => answer.result?.active === 2,
            times: 12,
          }),
        );
        expectOk(body);
        expect(body.result).toEqual({
          active: 2,
          running: 0,
          completed: 0,
          succeeded: 0,
          failed: 0,
        });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.CreateTask", () => {
    test(
      "adds a task to a job the deployer created",
      Effect.gen(function* () {
        yield* seedJob("task-job");
        const body = yield* call("/create-task?job=task-job&task=created-task");
        expectOk(body);
        const task = yield* observeTask("task-job", "created-task");
        expect({ state: task.state, commandLine: task.commandLine }).toEqual({
          state: "active",
          commandLine: "/bin/sh -c 'echo created'",
        });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.CreateTaskCollection", () => {
    test(
      "adds two tasks in one call",
      Effect.gen(function* () {
        yield* seedJob("collection-job");
        const body = yield* call("/create-tasks?job=collection-job");
        expectOk(body);
        expect(body.result).toEqual([
          { taskId: "one", status: "Success" },
          { taskId: "two", status: "Success" },
        ]);
        const url = yield* endpoint;
        const listed = yield* data
          .ListTaskTasks({ endpoint: url, jobId: "collection-job" })
          .pipe(Effect.provide(azure));
        expect(listed.value.map((task) => task.id).sort()).toEqual(["one", "two"]);
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.GetTask", () => {
    test(
      "reads a task the deployer added",
      Effect.gen(function* () {
        yield* seedJob("read-task-job");
        yield* seedTask("read-task-job", "read-task");
        const body = yield* call("/get-task?job=read-task-job&task=read-task");
        expectOk(body);
        expect(body.result).toEqual({ id: "read-task", commandLine: "/bin/sh -c 'echo seed'" });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.ListTasks", () => {
    test(
      "lists the tasks the deployer added",
      Effect.gen(function* () {
        yield* seedJob("list-task-job");
        yield* seedTask("list-task-job", "alpha");
        yield* seedTask("list-task-job", "beta");
        const body = yield* call("/list-tasks?job=list-task-job");
        expectOk(body);
        expect(body.result).toEqual(["alpha", "beta"]);
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.TerminateTask", () => {
    test(
      "terminates a task the deployer added",
      Effect.gen(function* () {
        yield* seedJob("terminate-task-job");
        yield* seedTask("terminate-task-job", "stopped-task");
        const body = yield* call("/terminate-task?job=terminate-task-job&task=stopped-task");
        expectOk(body);
        const state = yield* observeTask("terminate-task-job", "stopped-task").pipe(
          Effect.map((task) => task.state as string),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (observed) => observed === "completed",
            times: 24,
          }),
        );
        expect(state).toEqual("completed");
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.DeleteTask", () => {
    test(
      "deletes a task the deployer added",
      Effect.gen(function* () {
        yield* seedJob("delete-task-job");
        yield* seedTask("delete-task-job", "deleted-task");
        const body = yield* call("/delete-task?job=delete-task-job&task=deleted-task");
        expectOk(body);
        expect(yield* taskGone("delete-task-job", "deleted-task")).toEqual("gone");
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.CreateJobSchedule", () => {
    test(
      "creates a job schedule in the bound account",
      Effect.gen(function* () {
        const body = yield* call("/create-schedule?schedule=created-schedule");
        expectOk(body);
        const schedule = yield* observeJobSchedule("created-schedule");
        expect({
          state: schedule.state,
          recurrenceInterval: schedule.schedule?.recurrenceInterval,
          poolId: schedule.jobSpecification.poolInfo.poolId,
        }).toEqual({ state: "active", recurrenceInterval: RECURRENCE, poolId: POOL_ID });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.GetJobSchedule", () => {
    test(
      "reads a job schedule the deployer created",
      Effect.gen(function* () {
        yield* seedJobSchedule("read-schedule");
        const body = yield* call("/get-schedule?schedule=read-schedule");
        expectOk(body);
        expect(body.result).toEqual({ id: "read-schedule", state: "active" });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.ListJobSchedules", () => {
    test(
      "lists a job schedule the deployer created",
      Effect.gen(function* () {
        yield* seedJobSchedule("listed-schedule");
        const body = yield* call("/list-schedules?schedule=listed-schedule");
        expectOk(body);
        expect(body.result).toEqual(["listed-schedule"]);
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.DeleteJobSchedule", () => {
    test(
      "deletes a job schedule the deployer created",
      Effect.gen(function* () {
        yield* seedJobSchedule("deleted-schedule");
        const body = yield* call("/delete-schedule?schedule=deleted-schedule");
        expectOk(body);
        expect(yield* jobScheduleGone("deleted-schedule")).toEqual("gone");
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.GetPool", () => {
    test(
      "answers the typed not-found for a pool the account does not have",
      Effect.gen(function* () {
        // The account's pool quota is 0, so no pool can exist to read.
        const body = yield* call("/get-pool");
        expectOk(body);
        expect(body.result).toEqual({ missing: "BatchPoolNotFound" });
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.ListPools", () => {
    test(
      "lists the same pools as the management API",
      Effect.gen(function* () {
        const { resourceGroup, accountName } = yield* stack;
        const body = yield* call("/list-pools");
        expectOk(body);
        const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(
          Effect.provide(azure),
        );
        const pools = yield* Stream.runCollect(
          batch.ListPoolByBatchAccount.items({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName,
          }),
        ).pipe(Effect.provide(azure));
        expect(body.result).toEqual(Array.from(pools, (pool) => pool.name).sort());
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.ListApplications", () => {
    test(
      "lists no applications for an account without packages",
      Effect.gen(function* () {
        const body = yield* call("/list-applications");
        expectOk(body);
        expect(body.result).toEqual([]);
      }),
      { timeout: 600_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly each binding kind's permissions on the account only",
      Effect.gen(function* () {
        const outputs = yield* stack;
        expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
        // Role-assignment lists trail new assignments by a few minutes.
        const grants = yield* grantsOf(outputs.principalId!, outputs.hostStorageAccount).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (listed) => listed.length >= 8,
            times: 18,
          }),
          Effect.provide(azure),
        );
        const account = outputs.accountId.toLowerCase();
        expect(grants).toEqual(
          [
            "Microsoft.Batch/batchAccounts/jobs/read",
            "Microsoft.Batch/batchAccounts/jobs/write",
            "Microsoft.Batch/batchAccounts/jobs/delete",
            "Microsoft.Batch/batchAccounts/jobSchedules/read",
            "Microsoft.Batch/batchAccounts/jobSchedules/write",
            "Microsoft.Batch/batchAccounts/jobSchedules/delete",
            "Microsoft.Batch/batchAccounts/pools/read",
            "Microsoft.Batch/batchAccounts/applications/read+Microsoft.Batch/batchAccounts/applications/versions/read+Microsoft.Batch/batchAccounts/read",
          ]
            .map((permission) => `${permission} ${account}`)
            .sort(),
        );
      }),
      { timeout: 300_000 },
    );
  });
});

// Destroy, then prove the account and every role assigned to the
// Function's identity are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, hostStorageAccount, resourceGroup, accountName } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    // Role-assignment lists trail deletes by minutes (eight grants here
    // were still listed 60 s after the Function revoked them).
    const remaining = yield* assignmentsOf(principalId!, hostStorageAccount).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 24,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    expect(
      yield* waitGone(
        batch.GetBatchAccount({ subscriptionId, resourceGroupName: resourceGroup, accountName }),
      ),
    ).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
