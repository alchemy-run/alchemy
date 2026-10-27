import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { expectAuditEntry } from "../auditLogs.ts";
import { expectProbe } from "../bindingHost.ts";
import RunBindingsHost, {
  Api,
  AuditMarkers,
  Callee,
  GenApi,
  GenJob,
  GenWorkers,
  Migrate,
  Workers,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RunBindings");

let baseUrl: string;
let auditMarkers: string;
let member: string;
let names: {
  api: string;
  callee: string;
  calleeUri: string;
  workers: string;
  job: string;
  genApi: string;
  genWorkers: string;
  genJob: string;
};

type Policy = { bindings?: { role?: string; members?: string[] }[] };

const rolesOf = (policy: Policy) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort();

const serviceRoles = (name: string) =>
  cloudrun
    .getIamPolicyProjectsLocationsServices({
      resource: name,
      "options.requestedPolicyVersion": 3,
    })
    .pipe(Effect.map(rolesOf));

describe("Run Bindings", { tags: ["provider:gcp", "provider:gcp:run", "live"] }, () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const out = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const host = yield* RunBindingsHost;
          const callee = yield* Callee;
          return {
            uri: host.uri,
            serviceAccount: host.serviceAccount,
            auditMarkers: (yield* AuditMarkers).bucketName,
            api: (yield* Api).name,
            callee: callee.name,
            calleeUri: callee.uri,
            workers: (yield* Workers).name,
            job: (yield* Migrate).name,
            genApi: (yield* GenApi).name,
            genWorkers: (yield* GenWorkers).name,
            genJob: (yield* GenJob).name,
          };
        }),
      );
      baseUrl = out.uri!;
      auditMarkers = out.auditMarkers;
      member = `serviceAccount:${out.serviceAccount!}`;
      names = { ...out, calleeUri: out.calleeUri! };
    }),
    { timeout: 900_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 600_000 });

  describe("GetService", () => {
    test.provider(
      "reads the service, granted viewer on the service only",
      (_stack) =>
        Effect.gen(function* () {
          const live = yield* expectProbe<cloudrun.GoogleCloudRunV2Service>(baseUrl, "getService");
          expect(live.name).toEqual(names.api);
          expect(live.template?.containers?.[0]?.image).toEqual(
            "us-docker.pkg.dev/cloudrun/container/hello",
          );
          expect(yield* serviceRoles(names.api)).toEqual(["roles/run.viewer"]);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:run", "live"],
        timeout: 600_000,
      },
    );
  });

  describe("GetWorkerPool", () => {
    test.provider(
      "reads the worker pool, granted viewer on the pool only",
      (_stack) =>
        Effect.gen(function* () {
          const live = yield* expectProbe<cloudrun.GoogleCloudRunV2WorkerPool>(
            baseUrl,
            "getWorkerPool",
          );
          expect(live.name).toEqual(names.workers);

          const policy = yield* cloudrun.getIamPolicyProjectsLocationsWorkerPools({
            resource: names.workers,
            "options.requestedPolicyVersion": 3,
          });
          expect(rolesOf(policy)).toEqual(["roles/run.viewer"]);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:run", "live"],
        timeout: 600_000,
      },
    );
  });

  describe("RunJob", () => {
    test.provider(
      "starts an execution, granted jobsExecutorWithOverrides on the job only",
      (_stack) =>
        Effect.gen(function* () {
          const operation = yield* expectProbe<cloudrun.GoogleLongrunningOperation>(
            baseUrl,
            "runJob",
          );
          const executionName = operation.metadata?.name;
          expect(typeof executionName).toEqual("string");
          expect(String(executionName)).toContain(`${names.job}/executions/`);

          // Out of band: the execution exists under the bound job.
          const execution = yield* cloudrun.getProjectsLocationsJobsExecutions({
            name: String(executionName),
          });
          expect(execution.name).toEqual(executionName);

          const policy = yield* cloudrun.getIamPolicyProjectsLocationsJobs({
            resource: names.job,
            "options.requestedPolicyVersion": 3,
          });
          expect(rolesOf(policy)).toEqual(["roles/run.jobsExecutorWithOverrides"]);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:run", "live"],
        timeout: 600_000,
      },
    );
  });

  describe("InvokeService", () => {
    test.provider(
      "calls the private service with an ID token, granted invoker on it only",
      (_stack) =>
        Effect.gen(function* () {
          const out = yield* expectProbe<{ status: number; text: string }>(
            baseUrl,
            "invokeService",
          );
          expect(out.status).toEqual(200);
          expect(out.text).toContain("It's running!");

          // Without a token Cloud Run rejects the call at its front end.
          const direct = yield* HttpClient.get(names.calleeUri);
          expect(direct.status).toEqual(403);

          expect(yield* serviceRoles(names.callee)).toEqual(["roles/run.invoker"]);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:run", "live"],
        timeout: 600_000,
      },
    );
  });

  const live = { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 600_000 };

  describe("GetJob / ListJobExecutions / GetJobExecution / ListJobExecutionTasks / GetJobExecutionTask / CancelJobExecution / DeleteJobExecution", () => {
    test.provider(
      "inspects, cancels and deletes an execution as the host, granted on the job only",
      (_stack) =>
        Effect.gen(function* () {
          const job = yield* expectProbe<{ name?: string }>(baseUrl, "getJob");
          expect(job.name).toEqual(names.genJob);

          // Start an execution out of band; the bindings only read and manage it.
          const started = yield* cloudrun.runProjectsLocationsJobs({
            name: names.genJob,
            body: {},
          });
          const executionName = String(started.metadata?.name);
          const id = executionName.split("/").at(-1)!;

          const listed = yield* expectProbe<{ executions?: { name?: string }[] }>(
            baseUrl,
            "listExecutions",
          );
          expect(listed.executions?.map((e) => e.name)).toContain(executionName);
          const out = yield* expectProbe<{
            execution: { name?: string };
            tasks: { tasks?: { name?: string }[] };
            task: { name?: string };
          }>(baseUrl, `execution?execution=${id}`).pipe(
            // Tasks appear once the execution is scheduled.
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r) => (r.tasks.tasks ?? []).length > 0,
              times: 20,
            }),
          );
          expect(out.execution.name).toEqual(executionName);
          expect(out.task.name).toEqual(out.tasks.tasks?.[0]?.name);

          yield* expectProbe(baseUrl, `cancelExecution?execution=${id}`);
          yield* expectProbe(baseUrl, `deleteExecution?execution=${id}`);
          const gone = yield* cloudrun
            .getProjectsLocationsJobsExecutions({ name: executionName })
            .pipe(
              Effect.flip,
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (error) => error._tag === "NotFound",
                times: 20,
              }),
            );
          expect(gone._tag).toEqual("NotFound");

          const policy = yield* cloudrun.getIamPolicyProjectsLocationsJobs({
            resource: names.genJob,
            "options.requestedPolicyVersion": 3,
          });
          expect(rolesOf(policy)).toEqual([
            "roles/run.developer",
            "roles/run.jobsExecutor",
            "roles/run.viewer",
          ]);
        }),
      live,
    );
  });

  describe("ListServiceRevisions / GetServiceRevision / DeleteServiceRevision / ListWorkerPoolRevisions / GetWorkerPoolRevision / DeleteWorkerPoolRevision", () => {
    test.provider(
      "reads revisions as the host and is refused deleting the serving one",
      (_stack) =>
        Effect.gen(function* () {
          const service = yield* expectProbe<{
            listed: { revisions?: { name?: string }[] };
            got: { name?: string };
            delete: string;
          }>(baseUrl, "revisions");
          expect(service.got.name).toEqual(service.listed.revisions?.[0]?.name);
          expect(service.got.name).toContain(`${names.genApi}/revisions/`);
          expect(service.delete).toEqual("BadRequest");

          const pool = yield* expectProbe<{
            listed: { revisions?: { name?: string }[] };
            got: { name?: string };
            delete: string;
          }>(baseUrl, "poolRevisions");
          expect(pool.got.name).toContain(`${names.genWorkers}/revisions/`);
          expect(pool.delete).toEqual("BadRequest");

          expect(yield* serviceRoles(names.genApi)).toEqual([
            "roles/run.developer",
            "roles/run.viewer",
          ]);
          const poolPolicy = yield* cloudrun.getIamPolicyProjectsLocationsWorkerPools({
            resource: names.genWorkers,
            "options.requestedPolicyVersion": 3,
          });
          expect(rolesOf(poolPolicy)).toEqual(["roles/run.developer", "roles/run.viewer"]);
        }),
      live,
    );
  });

  describe("consumeServiceAuditLogs / consumeJobAuditLogs / consumeWorkerPoolAuditLogs", () => {
    test.provider(
      "deliver each resource's audit log entries to the host",
      (_stack) =>
        Effect.gen(function* () {
          // Admin Activity calls that change nothing (or only a description).
          const cases = [
            {
              key: "service",
              name: names.genApi,
              method: "SetIamPolicy",
              trigger: cloudrun
                .getIamPolicyProjectsLocationsServices({ resource: names.genApi })
                .pipe(
                  Effect.flatMap((policy) =>
                    cloudrun.setIamPolicyProjectsLocationsServices({
                      resource: names.genApi,
                      body: { policy },
                    }),
                  ),
                ),
            },
            {
              key: "job",
              name: names.genJob,
              method: "SetIamPolicy",
              trigger: cloudrun.getIamPolicyProjectsLocationsJobs({ resource: names.genJob }).pipe(
                Effect.flatMap((policy) =>
                  cloudrun.setIamPolicyProjectsLocationsJobs({
                    resource: names.genJob,
                    body: { policy },
                  }),
                ),
              ),
            },
            {
              key: "workerPool",
              name: names.genWorkers,
              method: "SetIamPolicy",
              trigger: cloudrun
                .getIamPolicyProjectsLocationsWorkerPools({ resource: names.genWorkers })
                .pipe(
                  Effect.flatMap((policy) =>
                    cloudrun.setIamPolicyProjectsLocationsWorkerPools({
                      resource: names.genWorkers,
                      body: { policy },
                    }),
                  ),
                ),
            },
          ];
          for (const { key, name, method, trigger } of cases) {
            const entry = yield* expectAuditEntry({ bucket: auditMarkers, key, method, trigger });
            expect(entry.serviceName).toEqual("run.googleapis.com");
            // Audit logs may name the project by number.
            const path = (value: string) => value.replace(/^projects\/[^/]+/, "");
            expect(path(entry.resourceName)).toContain(path(name));
          }
        }),
      { tags: ["provider:gcp", "live"], timeout: 900_000 },
    );
  });
});
