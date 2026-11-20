import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordAuditLogs } from "../../auditLogs.ts";
import { probeParam, serveProbes } from "../../bindingHost.ts";

/** Queue the binding is granted on (roles/cloudtasks.enqueuer). */
export const Jobs = GCP.CloudTasks.Queue("Jobs", { location: "us-central1" });

/**
 * Queue the generated bindings bind. Deployed paused so no task dispatches
 * unless `RunQueueTask` forces it; the queue-level HTTP target is what
 * `BufferTask` sends to.
 */
export const GenQueue = GCP.CloudTasks.Queue("GenQueue", {
  location: "us-central1",
  state: "PAUSED",
  httpTarget: {
    httpMethod: "POST",
    uriOverride: { scheme: "HTTPS", host: "example.com" },
  },
});

/** Target of the enqueued task; scheduled a day out so it never dispatches. */
export const TASK_URL = "https://example.com/alchemy-binding";

/**
 * Effect-native Cloud Run service exercising every Cloud Tasks binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */

/** Bucket the audit-log consumers record entries in. */
export const AuditMarkers = GCP.Storage.Bucket("AuditMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

export default class CloudTasksBindingsHost extends GCP.Function<CloudTasksBindingsHost>()(
  "CloudTasksBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const putMarker = yield* GCP.Storage.PutObject(AuditMarkers);
    yield* GCP.CloudTasks.consumeQueueAuditLogs(
      GenQueue,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("queue", putMarker),
    );
    const createTask = yield* GCP.CloudTasks.CreateTask(Jobs);
    const getQueue = yield* GCP.CloudTasks.GetQueue(GenQueue);
    const pauseQueue = yield* GCP.CloudTasks.PauseQueue(GenQueue);
    const resumeQueue = yield* GCP.CloudTasks.ResumeQueue(GenQueue);
    const purgeQueue = yield* GCP.CloudTasks.PurgeQueue(GenQueue);
    const bufferTask = yield* GCP.CloudTasks.BufferTask(GenQueue);
    const batchCreateTasks = yield* GCP.CloudTasks.BatchCreateTasks(GenQueue);
    const batchDeleteTasks = yield* GCP.CloudTasks.BatchDeleteTasks(GenQueue);
    const listTasks = yield* GCP.CloudTasks.ListQueueTasks(GenQueue);
    const getTask = yield* GCP.CloudTasks.GetQueueTask(GenQueue);
    const runTask = yield* GCP.CloudTasks.RunQueueTask(GenQueue);
    const deleteTask = yield* GCP.CloudTasks.DeleteQueueTask(GenQueue);

    const tomorrow = Effect.sync(() => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    /** `?tasks=a,b` → {@link GenQueue}'s name and the full names of tasks `a` and `b`. */
    const taskNames = Effect.gen(function* () {
      const queue = yield* getQueue();
      const ids = (yield* probeParam("tasks")).split(",");
      return { queue: queue.name!, names: ids.map((id) => `${queue.name}/tasks/${id}`) };
    });

    const listQueues = yield* GCP.CloudTasks.ListQueues();

    return {
      fetch: serveProbes({
        listQueues: listQueues({ location: "us-central1", pageSize: 1000 }).pipe(
          Effect.map((page) => (page.queues ?? []).map((queue) => queue.name)),
        ),
        createTask: Effect.gen(function* () {
          const scheduleTime = yield* tomorrow;
          return yield* createTask({
            body: {
              task: {
                scheduleTime,
                httpRequest: {
                  url: TASK_URL,
                  httpMethod: "POST",
                  body: btoa(JSON.stringify({ id: "1" })),
                },
              },
            },
          });
        }),
        getQueue: getQueue(),
        pauseQueue: pauseQueue({ body: {} }),
        resumeQueue: resumeQueue({ body: {} }),
        purgeQueue: purgeQueue({ body: {} }),
        bufferTask: Effect.gen(function* () {
          const taskId = yield* probeParam("task");
          return yield* bufferTask({
            taskId,
            body: { body: { contentType: "text/plain", data: btoa("buffered") } },
          });
        }),
        batchCreateTasks: Effect.gen(function* () {
          const { queue, names } = yield* taskNames;
          const scheduleTime = yield* tomorrow;
          return yield* batchCreateTasks({
            body: {
              requests: names.map((name) => ({
                parent: queue,
                task: { name, scheduleTime, httpRequest: { url: TASK_URL, httpMethod: "POST" } },
              })),
            },
          });
        }),
        listTasks: listTasks(),
        getTask: Effect.flatMap(probeParam("task"), (task) => getTask({ task })),
        runTask: Effect.flatMap(probeParam("task"), (task) => runTask({ task, body: {} })),
        deleteTask: Effect.flatMap(probeParam("task"), (task) => deleteTask({ task })),
        batchDeleteTasks: Effect.flatMap(taskNames, ({ names }) =>
          batchDeleteTasks({ body: { names } }),
        ),
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.CloudTasks.ListQueuesHttp,
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
        GCP.CloudTasks.CreateTaskHttp,
        GCP.CloudTasks.GetQueueHttp,
        GCP.CloudTasks.PauseQueueHttp,
        GCP.CloudTasks.ResumeQueueHttp,
        GCP.CloudTasks.PurgeQueueHttp,
        GCP.CloudTasks.BufferTaskHttp,
        GCP.CloudTasks.BatchCreateTasksHttp,
        GCP.CloudTasks.BatchDeleteTasksHttp,
        GCP.CloudTasks.ListQueueTasksHttp,
        GCP.CloudTasks.GetQueueTaskHttp,
        GCP.CloudTasks.RunQueueTaskHttp,
        GCP.CloudTasks.DeleteQueueTaskHttp,
      ),
    ),
  ),
) {}
