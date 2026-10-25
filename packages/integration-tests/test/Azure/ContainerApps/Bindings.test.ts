import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { runExpensive } from "../gates.ts";
import ContainerAppsBindingsFunction, { App, Job } from "./fixtures/bindings-function.ts";
import { logLevel, STANDARD_LOCATION, withStandardEnvironment } from "./fixtures/shared.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureContainerAppsBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* ContainerAppsBindingsFunction;
    const api = yield* App;
    const job = yield* Job;
    return {
      url: fn.url,
      principalId: fn.principalId,
      appName: api.containerAppName,
      appId: api.containerAppId,
      jobName: job.jobName,
      jobId: job.jobId,
      resourceGroup: api.resourceGroup,
    };
  }),
);

// ~$0.10/run, 35 min: a standard Consumption environment (free idle), a
// 0.25 vCPU app with one replica and a 0.25 vCPU job execution for a few
// minutes, Flex Consumption. Gated for time like `Job.test.ts`: the trial
// allows one standard environment per subscription and its delete takes
// 5-25 minutes. Run with AZURE_TEST_EXPENSIVE=1.
const stack = runExpensive
  ? beforeAll(deploy(Stack).pipe(withStandardEnvironment), { timeout: 1_800_000 })
  : undefined;

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack!;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Where the bound app and job live, as the deployer sees them. */
const where = Effect.gen(function* () {
  const { resourceGroup, appName, jobName } = yield* stack!;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  return { subscriptionId, resourceGroupName: resourceGroup, appName, jobName };
});

const getApp = Effect.gen(function* () {
  const { subscriptionId, resourceGroupName, appName } = yield* where;
  return yield* app.GetContainerApp({
    subscriptionId,
    resourceGroupName,
    containerAppName: appName,
  });
});

const getJob = Effect.gen(function* () {
  const { subscriptionId, resourceGroupName, jobName } = yield* where;
  return yield* app.GetJob({ subscriptionId, resourceGroupName, jobName });
});

const getExecution = (jobExecutionName: string) =>
  Effect.gen(function* () {
    const { subscriptionId, resourceGroupName, jobName } = yield* where;
    return yield* app.JobExecution2({
      subscriptionId,
      resourceGroupName,
      jobName,
      jobExecutionName,
    });
  });

const replicasOf = (revisionName: string) =>
  Effect.gen(function* () {
    const { subscriptionId, resourceGroupName, appName } = yield* where;
    const { value } = yield* app.ListContainerAppsRevisionReplicasReplicas({
      subscriptionId,
      resourceGroupName,
      containerAppName: appName,
      revisionName,
    });
    return value;
  });

/** Repeat a deployer read until `until` holds (bounded: about 5 minutes). */
const readUntil = <A, E, R>(read: Effect.Effect<A, E, R>, until: (value: A) => boolean) =>
  read.pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 seconds"), until, times: 30 }),
    Effect.provide(azure),
  );

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Every role on the Function's identity as `<actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
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

// Ungated probe (free, ~1 min): every action the bindings call reaches the
// Container Apps resource provider and answers the typed not-found error for
// a missing app or job, so the request paths encode correctly.
test.provider(
  "every bound action answers ResourceNotFound for a missing app or job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
            location: STANDARD_LOCATION,
          });
          return { group };
        }),
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const resourceGroupName = group.resourceGroupName;
      const appIds = { subscriptionId, resourceGroupName, containerAppName: "alchemy-missing" };
      const jobIds = { subscriptionId, resourceGroupName, jobName: "alchemy-missing" };
      const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.as("none"),
          Effect.catch((e) => Effect.succeed(e._tag)),
        );
      const tags = {
        startApp: yield* tagOf(app.StartContainerApp(appIds)),
        stopApp: yield* tagOf(app.StopContainerApp(appIds)),
        restartRevision: yield* tagOf(
          app.RestartContainerAppsRevisionRevision({ ...appIds, revisionName: "alchemy-missing" }),
        ),
        startJob: yield* tagOf(app.StartJob(jobIds)),
        stopExecution: yield* tagOf(
          app.StopJobExecution({ ...jobIds, jobExecutionName: "alchemy-missing" }),
        ),
        suspend: yield* tagOf(app.SuspendJob(jobIds)),
        resume: yield* tagOf(app.ResumeJob(jobIds)),
      };
      expect(tags).toEqual({
        startApp: "ResourceNotFound",
        stopApp: "ResourceNotFound",
        restartRevision: "ResourceNotFound",
        startJob: "ResourceNotFound",
        stopExecution: "ResourceNotFound",
        suspend: "ResourceNotFound",
        resume: "ResourceNotFound",
      });
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:azure", "live"], timeout: 300_000 },
);

describe.skipIf(!runExpensive)(
  "Container Apps runtime-action bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("ContainerApps.StopContainerApp", () => {
      test(
        "stops the running app",
        Effect.gen(function* () {
          yield* readUntil(getApp, (a) => a.properties?.runningStatus === "Running");
          expectOk(yield* call("/app/stop"));
          const stopped = yield* readUntil(
            getApp,
            (a) => a.properties?.runningStatus === "Stopped",
          );
          expect(stopped.properties?.runningStatus).toEqual("Stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("ContainerApps.StartContainerApp", () => {
      test(
        "starts the stopped app",
        Effect.gen(function* () {
          expectOk(yield* call("/app/start"));
          const running = yield* readUntil(
            getApp,
            (a) => a.properties?.runningStatus === "Running",
          );
          expect(running.properties?.runningStatus).toEqual("Running");
        }),
        { timeout: 600_000 },
      );
    });

    describe("ContainerApps.RestartContainerAppRevision", () => {
      test(
        "recreates the revision's replica",
        Effect.gen(function* () {
          const current = yield* getApp.pipe(Effect.provide(azure));
          const revision = current.properties?.latestReadyRevisionName ?? "";
          expect(revision).not.toEqual("");
          const before = yield* readUntil(
            replicasOf(revision),
            (replicas) =>
              replicas.length === 1 && replicas[0]?.properties?.createdTime !== undefined,
          );
          const createdAt = Date.parse(before[0]!.properties!.createdTime!);
          expectOk(yield* call(`/app/restart-revision?name=${revision}`));
          const after = yield* readUntil(replicasOf(revision), (replicas) =>
            replicas.some((r) => Date.parse(r.properties?.createdTime ?? "") > createdAt),
          );
          const newest = Math.max(...after.map((r) => Date.parse(r.properties?.createdTime ?? "")));
          expect(newest).toBeGreaterThan(createdAt);
        }),
        { timeout: 600_000 },
      );
    });

    describe("ContainerApps.StartJob + StopJobExecution", () => {
      test(
        "starts an execution, then stops it",
        Effect.gen(function* () {
          const started = yield* call("/job/start");
          expectOk(started);
          const name = started.result.name as string;
          expect(name).toMatch(/^[a-z0-9-]+$/);
          const running = yield* readUntil(
            getExecution(name),
            (e) => e.properties?.status === "Running",
          );
          expect(running.properties?.status).toEqual("Running");
          expectOk(yield* call(`/job/stop-execution?name=${name}`));
          const stopped = yield* readUntil(
            getExecution(name),
            (e) => e.properties?.status === "Stopped",
          );
          expect(stopped.properties?.status).toEqual("Stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("ContainerApps.SuspendJob", () => {
      test(
        "suspends the job",
        Effect.gen(function* () {
          expectOk(yield* call("/job/suspend"));
          const suspended = yield* readUntil(
            getJob,
            (j) => j.properties?.runningState === "Suspended",
          );
          expect(suspended.properties?.runningState).toEqual("Suspended");
        }),
        { timeout: 600_000 },
      );
    });

    describe("ContainerApps.ResumeJob", () => {
      test(
        "resumes the suspended job",
        Effect.gen(function* () {
          expectOk(yield* call("/job/resume"));
          const ready = yield* readUntil(getJob, (j) => j.properties?.runningState === "Ready");
          expect(ready.properties?.runningState).toEqual("Ready");
        }),
        { timeout: 600_000 },
      );
    });

    describe("least privilege", () => {
      test(
        "each binding is one custom role with its one action, on its app or job only",
        Effect.gen(function* () {
          const outputs = yield* stack!;
          const appScope = outputs.appId.toLowerCase();
          const jobScope = outputs.jobId.toLowerCase();
          const expected = [
            `Microsoft.App/containerApps/start/action ${appScope}`,
            `Microsoft.App/containerApps/stop/action ${appScope}`,
            `Microsoft.App/containerApps/revisions/restart/action ${appScope}`,
            `Microsoft.App/jobs/start/action ${jobScope}`,
            `Microsoft.App/jobs/stop/execution/action ${jobScope}`,
            `Microsoft.App/jobs/suspend/action ${jobScope}`,
            `Microsoft.App/jobs/resume/action ${jobScope}`,
          ].sort();
          // The filtered assignment list can trail the assignments by seconds.
          const grants = yield* grantsOf(outputs.principalId!).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (listed) => listed.length >= expected.length,
              times: 12,
            }),
            Effect.provide(azure),
          );
          expect(grants).toEqual(expected);
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove (the assignment list trails deletes by a minute or more) every role assigned to the Function's identity is gone.
if (runExpensive) {
  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      // A failed deploy yields no outputs; destroy still cleans up what it created.
      const outputs = yield* stack!;
      yield* destroy(Stack).pipe(withStandardEnvironment);
      const principalId = outputs?.principalId;
      expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
      const remaining = yield* assignmentsOf(principalId!).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (assignments) => assignments.length === 0,
          times: 24,
        }),
      );
      expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
    }).pipe(Effect.provide(azure)),
    { timeout: 3_600_000 },
  );
}
