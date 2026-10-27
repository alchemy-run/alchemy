import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectAuditEntry } from "../auditLogs.ts";
import { expectProbe } from "../bindingHost.ts";
import CloudTasksBindingsHost, {
  AuditMarkers,
  GenQueue,
  Jobs,
  TASK_URL,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudTasksBindings");

let baseUrl: string;
let auditMarkers: string;
let queueName: string;
let genQueueName: string;
let hostAccount: string;

const queueRoles = Effect.fn(function* (queue: string) {
  const policy = yield* cloudtasks.getIamPolicyProjectsLocationsQueues({ resource: queue });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
    .map((binding) => binding.role)
    .sort();
});

describe(
  "CloudTasks Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:cloudtasks", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* CloudTasksBindingsHost;
            const queue = yield* Jobs;
            const genQueue = yield* GenQueue;
            return {
              genQueue: genQueue.name,
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              auditMarkers: (yield* AuditMarkers).bucketName,
              queue: queue.name,
            };
          }),
        );
        baseUrl = out.uri!;
        auditMarkers = out.auditMarkers;
        queueName = out.queue;
        genQueueName = out.genQueue;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    const live = {
      tags: ["provider:gcp", "provider:gcp:cloudtasks", "live"],
      timeout: 600_000,
    };

    describe("CreateTask", () => {
      test.provider(
        "enqueues a task as the host's service account, granted on the queue only",
        (_stack) =>
          Effect.gen(function* () {
            const task = yield* expectProbe<cloudtasks.Task>(baseUrl, "createTask");
            expect(task.name?.startsWith(`${queueName}/tasks/`)).toBe(true);
            expect(task.httpRequest?.url).toEqual(TASK_URL);

            const live = yield* cloudtasks.getProjectsLocationsQueuesTasks({
              name: task.name!,
            });
            expect(live.name).toEqual(task.name);
            expect(live.httpRequest?.url).toEqual(TASK_URL);
            expect(live.httpRequest?.httpMethod).toEqual("POST");

            const policy = yield* cloudtasks.getIamPolicyProjectsLocationsQueues({
              resource: queueName,
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
              )
              .map((binding) => binding.role)
              .sort();
            expect(roles).toEqual(["roles/cloudtasks.enqueuer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudtasks", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetQueue / PauseQueue / ResumeQueue", () => {
      test.provider(
        "reads and flips the queue's state as the host, granted on the queue only",
        (_stack) =>
          Effect.gen(function* () {
            const queue = yield* expectProbe<cloudtasks.Queue>(baseUrl, "getQueue");
            expect(queue).toMatchObject({ name: genQueueName, state: "PAUSED" });

            const resumed = yield* expectProbe<cloudtasks.Queue>(baseUrl, "resumeQueue");
            expect(resumed.state).toEqual("RUNNING");
            const paused = yield* expectProbe<cloudtasks.Queue>(baseUrl, "pauseQueue");
            expect(paused.state).toEqual("PAUSED");
            const live = yield* cloudtasks.getProjectsLocationsQueues({ name: genQueueName });
            expect(live.state).toEqual("PAUSED");
          }),
        live,
      );
    });

    describe("BufferTask / BatchCreateTasks / ListQueueTasks / GetQueueTask / RunQueueTask / DeleteQueueTask / BatchDeleteTasks / PurgeQueue", () => {
      test.provider(
        "creates, reads, runs and deletes tasks as the host, granted on the queue only",
        (_stack) =>
          Effect.gen(function* () {
            // Task ids stay reserved for up to a day after deletion, so each run uses fresh ones.
            const run = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
            const [buffered, a, b] = ["buffered", "a", "b"].map((id) => `${id}-${run}`);
            const taskName = (id: string) => `${genQueueName}/tasks/${id}`;

            const buffer = yield* expectProbe<{ task?: cloudtasks.Task }>(
              baseUrl,
              `bufferTask?task=${buffered}`,
            );
            expect(buffer.task?.name).toEqual(taskName(buffered!));

            yield* expectProbe(baseUrl, `batchCreateTasks?tasks=${a},${b}`);
            // Batch creation is a long-running operation; wait for both tasks to list.
            const listed = yield* expectProbe<{ tasks?: cloudtasks.Task[] }>(
              baseUrl,
              "listTasks",
            ).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (out) => (out.tasks ?? []).length >= 3,
                times: 20,
              }),
            );
            expect((listed.tasks ?? []).map((t) => t.name).sort()).toEqual(
              [buffered!, a!, b!].map(taskName).sort(),
            );

            const got = yield* expectProbe<cloudtasks.Task>(baseUrl, `getTask?task=${a}`);
            expect(got.httpRequest?.url).toEqual(TASK_URL);

            const ran = yield* expectProbe<cloudtasks.Task>(baseUrl, `runTask?task=${a}`);
            expect(ran.name).toEqual(taskName(a!));

            yield* expectProbe(baseUrl, `deleteTask?task=${b}`);
            yield* expectProbe(baseUrl, `batchDeleteTasks?tasks=${buffered}`);
            const gone = yield* cloudtasks
              .getProjectsLocationsQueuesTasks({ name: taskName(b!) })
              .pipe(Effect.flip);
            expect(gone._tag).toEqual("NotFound");

            // Last: a purge also drops tasks created up to a minute after it.
            const purged = yield* expectProbe<cloudtasks.Queue>(baseUrl, "purgeQueue");
            expect(purged.purgeTime).toBeDefined();

            expect(yield* queueRoles(genQueueName)).toEqual([
              "roles/cloudtasks.enqueuer",
              "roles/cloudtasks.queueAdmin",
              "roles/cloudtasks.taskDeleter",
              "roles/cloudtasks.taskRunner",
              "roles/cloudtasks.viewer",
            ]);
          }),
        live,
      );
    });

    describe("consumeQueueAuditLogs", () => {
      test.provider(
        "deliver each resource's audit log entries to the host",
        (_stack) =>
          Effect.gen(function* () {
            // Admin Activity calls that change nothing (or only a description).
            const cases = [
              {
                key: "queue",
                name: genQueueName,
                method: "SetIamPolicy",
                trigger: cloudtasks
                  .getIamPolicyProjectsLocationsQueues({ resource: genQueueName, body: {} })
                  .pipe(
                    Effect.flatMap((policy) =>
                      cloudtasks.setIamPolicyProjectsLocationsQueues({
                        resource: genQueueName,
                        body: { policy },
                      }),
                    ),
                  ),
              },
            ];
            for (const { key, name, method, trigger } of cases) {
              const entry = yield* expectAuditEntry({ bucket: auditMarkers, key, method, trigger });
              expect(entry.serviceName).toEqual("cloudtasks.googleapis.com");
              // Audit logs may name the project by number.
              const path = (value: string) => value.replace(/^projects\/[^/]+/, "");
              expect(path(entry.resourceName)).toContain(path(name));
            }
          }),
        { tags: ["provider:gcp", "live"], timeout: 900_000 },
      );
    });
  },
);
