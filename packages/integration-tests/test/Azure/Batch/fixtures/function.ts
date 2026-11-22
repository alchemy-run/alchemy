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
 * The free trial allows one Batch account per region; the other Batch
 * suites use eastus, centralus, westus2, westus3 and eastus2.
 */
export const BATCH_LOCATION = "northcentralus";

export const Jobs = Azure.Batch.Account("BatchBindingsAccount", { location: BATCH_LOCATION });

/**
 * Pool the jobs target. The account's pool quota is 0 on this subscription
 * (`Conflict: Pool quota for the account has been reached`), so no pool
 * exists: Batch accepts jobs for a missing pool and keeps them `active`.
 */
export const POOL_ID = "binding-pool";

/**
 * Recurrence of the test job schedules: one job at creation, the next a
 * week later (Batch rejects a far-future `doNotRunUntil` with
 * `InvalidPropertyValue`). The jobs target the missing pool, so none runs.
 */
export const RECURRENCE = "P7D";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Batch data-plane binding on
 * a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the Batch
 * error.
 */
export default class BatchFunction extends Azure.Functions.Function<BatchFunction>()(
  "BatchFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* Jobs;

    const createJob = yield* Azure.Batch.CreateJob(account);
    const getJob = yield* Azure.Batch.GetJob(account);
    const listJobs = yield* Azure.Batch.ListJobs(account);
    const updateJob = yield* Azure.Batch.UpdateJob(account);
    const deleteJob = yield* Azure.Batch.DeleteJob(account);
    const terminateJob = yield* Azure.Batch.TerminateJob(account);
    const getJobTaskCounts = yield* Azure.Batch.GetJobTaskCounts(account);
    const createTask = yield* Azure.Batch.CreateTask(account);
    const createTasks = yield* Azure.Batch.CreateTaskCollection(account);
    const getTask = yield* Azure.Batch.GetTask(account);
    const listTasks = yield* Azure.Batch.ListTasks(account);
    const terminateTask = yield* Azure.Batch.TerminateTask(account);
    const deleteTask = yield* Azure.Batch.DeleteTask(account);
    const createJobSchedule = yield* Azure.Batch.CreateJobSchedule(account);
    const getJobSchedule = yield* Azure.Batch.GetJobSchedule(account);
    const listJobSchedules = yield* Azure.Batch.ListJobSchedules(account);
    const deleteJobSchedule = yield* Azure.Batch.DeleteJobSchedule(account);
    const getPool = yield* Azure.Batch.GetPool(account);
    const listPools = yield* Azure.Batch.ListPools(account);
    const listApplications = yield* Azure.Batch.ListApplications(account);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const jobId = url.searchParams.get("job") ?? "";
        const taskId = url.searchParams.get("task") ?? "";
        const jobScheduleId = url.searchParams.get("schedule") ?? "";
        switch (url.pathname) {
          case "/create-job":
            return yield* respond(
              Effect.as(createJob({ id: jobId, poolInfo: { poolId: POOL_ID }, priority: 7 }), {
                created: jobId,
              }),
            );
          case "/get-job":
            return yield* respond(
              Effect.map(getJob({ jobId }), (job) => ({
                id: job.id,
                state: job.state,
                priority: job.priority,
              })),
            );
          case "/list-jobs":
            return yield* respond(
              Effect.map(listJobs({ _filter: `id eq '${jobId}'` }), (page) =>
                page.value.map((job) => job.id),
              ),
            );
          case "/update-job":
            return yield* respond(Effect.as(updateJob({ jobId, priority: 100 }), { jobId }));
          case "/delete-job":
            return yield* respond(Effect.as(deleteJob({ jobId }), { jobId }));
          case "/terminate-job":
            return yield* respond(
              Effect.as(terminateJob({ jobId, terminateReason: "binding-test" }), { jobId }),
            );
          case "/task-counts":
            return yield* respond(
              Effect.map(getJobTaskCounts({ jobId }), (counts) => counts.taskCounts),
            );
          case "/create-task":
            return yield* respond(
              Effect.as(
                createTask({ jobId, id: taskId, commandLine: "/bin/sh -c 'echo created'" }),
                { taskId },
              ),
            );
          case "/create-tasks":
            return yield* respond(
              Effect.map(
                createTasks({
                  jobId,
                  value: [
                    { id: "one", commandLine: "/bin/sh -c 'echo one'" },
                    { id: "two", commandLine: "/bin/sh -c 'echo two'" },
                  ],
                }),
                (result) =>
                  (result.value ?? [])
                    .map((task) => ({ taskId: task.taskId, status: task.status }))
                    .sort((a, b) => a.taskId.localeCompare(b.taskId)),
              ),
            );
          case "/get-task":
            return yield* respond(
              Effect.map(getTask({ jobId, taskId }), (task) => ({
                id: task.id,
                commandLine: task.commandLine,
              })),
            );
          case "/list-tasks":
            return yield* respond(
              Effect.map(listTasks({ jobId }), (page) => page.value.map((task) => task.id).sort()),
            );
          case "/terminate-task":
            return yield* respond(Effect.as(terminateTask({ jobId, taskId }), { taskId }));
          case "/delete-task":
            return yield* respond(Effect.as(deleteTask({ jobId, taskId }), { taskId }));
          case "/create-schedule":
            return yield* respond(
              Effect.as(
                createJobSchedule({
                  id: jobScheduleId,
                  schedule: { recurrenceInterval: RECURRENCE },
                  jobSpecification: { poolInfo: { poolId: POOL_ID } },
                }),
                { created: jobScheduleId },
              ),
            );
          case "/get-schedule":
            return yield* respond(
              Effect.map(getJobSchedule({ jobScheduleId }), (schedule) => ({
                id: schedule.id,
                state: schedule.state,
              })),
            );
          case "/list-schedules":
            return yield* respond(
              Effect.map(listJobSchedules({ _filter: `id eq '${jobScheduleId}'` }), (page) =>
                page.value.map((schedule) => schedule.id),
              ),
            );
          case "/delete-schedule":
            return yield* respond(
              Effect.as(deleteJobSchedule({ jobScheduleId }), { jobScheduleId }),
            );
          case "/get-pool":
            return yield* respond(
              getPool({ poolId: POOL_ID }).pipe(
                Effect.map((observed) => ({ found: observed.id })),
                Effect.catchTag("BatchPoolNotFound", (e) => Effect.succeed({ missing: e._tag })),
              ),
            );
          case "/list-pools":
            return yield* respond(
              Effect.map(listPools(), (page) => page.value.map((pool) => pool.id).sort()),
            );
          case "/list-applications":
            return yield* respond(
              Effect.map(listApplications(), (page) => page.value.map((app) => app.id).sort()),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Batch.CreateJobHttp,
        Azure.Batch.GetJobHttp,
        Azure.Batch.ListJobsHttp,
        Azure.Batch.UpdateJobHttp,
        Azure.Batch.DeleteJobHttp,
        Azure.Batch.TerminateJobHttp,
        Azure.Batch.GetJobTaskCountsHttp,
        Azure.Batch.CreateTaskHttp,
        Azure.Batch.CreateTaskCollectionHttp,
        Azure.Batch.GetTaskHttp,
        Azure.Batch.ListTasksHttp,
        Azure.Batch.TerminateTaskHttp,
        Azure.Batch.DeleteTaskHttp,
        Azure.Batch.CreateJobScheduleHttp,
        Azure.Batch.GetJobScheduleHttp,
        Azure.Batch.ListJobSchedulesHttp,
        Azure.Batch.DeleteJobScheduleHttp,
        Azure.Batch.GetPoolHttp,
        Azure.Batch.ListPoolsHttp,
        Azure.Batch.ListApplicationsHttp,
      ),
    ),
  ),
) {}
