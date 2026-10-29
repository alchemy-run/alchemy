import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectAuditEntry } from "../auditLogs.ts";
import { expectProbe } from "../bindingHost.ts";
import SchedulerBindingsHost, {
  AuditMarkers,
  PausedJob,
  ResumedJob,
  RunJobTarget,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudSchedulerBindings");

let baseUrl: string;
let auditMarkers: string;
let hostAccount: string;
let project: string;
let jobs: { paused: string; resumed: string; run: string };

/**
 * The host's project-level roles. Cloud Scheduler has no per-job IAM
 * policy: Pause/Resume grant `roles/cloudscheduler.admin` (the only
 * predefined role with `jobs.pause`/`jobs.enable`), Run grants
 * `roles/cloudscheduler.jobRunner` and Get grants
 * `roles/cloudscheduler.viewer`, all on the project.
 */
const expectProjectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
    .map((binding) => ({ role: binding.role, condition: binding.condition }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
  expect(roles).toEqual([
    { role: "roles/cloudscheduler.admin", condition: undefined },
    { role: "roles/cloudscheduler.jobRunner", condition: undefined },
    { role: "roles/cloudscheduler.viewer", condition: undefined },
  ]);
  // ListJobs adds no role: its viewer grant is already there.
});

const getJob = (name: string) => scheduler.getProjectsLocationsJobs({ name });

describe(
  "CloudScheduler Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:cloudscheduler", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* SchedulerBindingsHost;
            const paused = yield* PausedJob;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              auditMarkers: (yield* AuditMarkers).bucketName,
              project: paused.project,
              paused: paused.name,
              resumed: (yield* ResumedJob).name,
              run: (yield* RunJobTarget).name,
            };
          }),
        );
        baseUrl = out.uri!;
        auditMarkers = out.auditMarkers;
        hostAccount = out.serviceAccount!;
        project = out.project;
        jobs = { paused: out.paused, resumed: out.resumed, run: out.run };
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("PauseJob", () => {
      test.provider(
        "pauses the job as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const job = yield* expectProbe<scheduler.Job>(baseUrl, "pause");
            expect(job.name).toEqual(jobs.paused);
            expect(job.state).toEqual("PAUSED");
            expect((yield* getJob(jobs.paused)).state).toEqual("PAUSED");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ResumeJob", () => {
      test.provider(
        "resumes a paused job as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* scheduler.pauseProjectsLocationsJobs({
              name: jobs.resumed,
            });
            expect((yield* getJob(jobs.resumed)).state).toEqual("PAUSED");
            const job = yield* expectProbe<scheduler.Job>(baseUrl, "resume");
            expect(job.name).toEqual(jobs.resumed);
            expect(job.state).toEqual("ENABLED");
            expect((yield* getJob(jobs.resumed)).state).toEqual("ENABLED");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("RunJob", () => {
      test.provider(
        "forces a run as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const job = yield* expectProbe<scheduler.Job>(baseUrl, "run");
            expect(job.name).toEqual(jobs.run);
            // The forced attempt is recorded on the job asynchronously.
            const after = yield* getJob(jobs.run).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (current) => current.lastAttemptTime !== undefined,
                times: 18,
              }),
            );
            expect(after.lastAttemptTime).toBeDefined();
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetJob", () => {
      test.provider(
        "reads the job as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const job = yield* expectProbe<scheduler.Job>(baseUrl, "getJob");
            expect(job).toMatchObject({ name: jobs.paused, schedule: "0 0 1 1 *" });
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("consumeJobAuditLogs", () => {
      test.provider(
        "deliver each resource's audit log entries to the host",
        (_stack) =>
          Effect.gen(function* () {
            // Admin Activity calls that change nothing (or only a description).
            const cases = [
              {
                key: "job",
                name: jobs.paused,
                method: "UpdateJob",
                trigger: scheduler.patchProjectsLocationsJobs({
                  name: jobs.paused,
                  updateMask: "description",
                  body: { description: "audited" },
                }),
              },
            ];
            for (const { key, name, method, trigger } of cases) {
              const entry = yield* expectAuditEntry({ bucket: auditMarkers, key, method, trigger });
              expect(entry.serviceName).toEqual("cloudscheduler.googleapis.com");
              // Audit logs may name the project by number.
              const path = (value: string) => value.replace(/^projects\/[^/]+/, "");
              expect(path(entry.resourceName)).toContain(path(name));
            }
          }),
        { tags: ["provider:gcp", "live"], timeout: 900_000 },
      );
    });

    describe("ListJobs", () => {
      test.provider(
        "lists a location's jobs",
        (_stack) =>
          Effect.gen(function* () {
            const listed = yield* expectProbe<string[]>(baseUrl, "listJobs");
            expect(listed).toContain(jobs.paused);
            yield* expectProjectGrants;
          }),
        { tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"], timeout: 600_000 },
      );
    });
  },
);
