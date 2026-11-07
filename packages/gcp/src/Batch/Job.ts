import * as batch from "@distilled.cloud/gcp/batch_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";

/** Job ids: lowercase letters, digits and hyphens, starting with a letter, up to 63 characters. */
const MAX_JOB_ID_LENGTH = 63;

export type JobProps = {
  /**
   * Job id (the `{job}` segment). If omitted, a unique id is generated.
   * Immutable — changing it replaces the job.
   */
  jobId?: string;
  /**
   * Region the job runs in. Immutable — changing it replaces the job.
   * @default the stack's GCP region
   */
  location?: string;
  /**
   * What the job runs: one task group with its runnables (scripts or
   * containers), task count and per-task resources. Batch jobs can't be
   * edited, so any change replaces the job.
   */
  taskGroups: batch.TaskGroup[];
  /** The VMs tasks run on: machine type, provisioning model, network, service account. */
  allocationPolicy?: batch.AllocationPolicy;
  /** Where task output goes (`CLOUD_LOGGING` or a path). */
  logsPolicy?: batch.LogsPolicy;
  /** Pub/Sub notifications on job and task state changes. */
  notifications?: batch.JobNotification[];
  /** Priority among the project's jobs, 0–99. */
  priority?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Labels are fixed at create, so changing them replaces the job.
   */
  labels?: Record<string, string>;
};

export type Job = Resource<
  "GCP.Batch.Job",
  JobProps,
  {
    /** Full name `projects/{project}/locations/{location}/jobs/{job}`. */
    name: string;
    /** Job id. */
    jobId: string;
    /** Project id. */
    project: string;
    /** Region. */
    location: string;
    /** Server-assigned unique id. */
    uid: string | undefined;
    /** Job state: `QUEUED`, `SCHEDULED`, `RUNNING`, `SUCCEEDED`, `FAILED`, … */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** When the job was created. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Batch job: tasks Batch schedules onto VMs it provisions, runs to
 * completion, and tears down.
 *
 * A job runs once. Batch jobs can't be edited, so changing any prop replaces
 * the job, which runs it again. Deleting the job cancels it if it is still
 * running.
 *
 * ### Running a Job
 * **Example:** A script run by three tasks
 * ```typescript
 * const job = yield* GCP.Batch.Job("Hello", {
 *   location: "us-central1",
 *   taskGroups: [
 *     {
 *       taskCount: "3",
 *       taskSpec: {
 *         runnables: [{ script: { text: "echo task $BATCH_TASK_INDEX" } }],
 *         computeResource: { cpuMilli: "1000", memoryMib: "512" },
 *       },
 *     },
 *   ],
 *   allocationPolicy: { instances: [{ policy: { machineType: "e2-small" } }] },
 *   logsPolicy: { destination: "CLOUD_LOGGING" },
 * });
 * ```
 *
 * **Example:** A container on Spot VMs
 * ```typescript
 * const job = yield* GCP.Batch.Job("Render", {
 *   taskGroups: [
 *     {
 *       taskSpec: {
 *         runnables: [{ container: { imageUri: "us-docker.pkg.dev/my-project/render/worker:latest" } }],
 *       },
 *     },
 *   ],
 *   allocationPolicy: {
 *     instances: [{ policy: { machineType: "e2-standard-4", provisioningModel: "SPOT" } }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Batch
 */
export const Job = Resource<Job>("GCP.Batch.Job");

export class JobNotResolved extends Data.TaggedError("GCP.Batch.JobNotResolved")<{
  resourceName: string;
}> {}

export class JobStillExists extends Data.TaggedError("GCP.Batch.JobStillExists")<{
  resourceName: string;
}> {}

const lastSegment = (value: string) => value.replace(/\/+$/, "").split("/").pop() ?? value;

const resourceName = (project: string, location: string, jobId: string) =>
  `projects/${project}/locations/${location}/jobs/${jobId}`;

const toJobId = (id: string, explicit: string | undefined, existing: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = (yield* createPhysicalName({
      id,
      maxLength: MAX_JOB_ID_LENGTH,
      lowercase: true,
    }))
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[^a-z]+/, "");
    return `${generated.length > 0 ? "" : "job-"}${generated}`
      .slice(0, MAX_JOB_ID_LENGTH)
      .replace(/-+$/, "");
  });

const getByName = (name: string) =>
  batch
    .getProjectsLocationsJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (job: batch.Job, project: string): Job["Attributes"] => {
  const name = job.name ?? "";
  const parts = name.split("/");
  return {
    name,
    jobId: lastSegment(name),
    project: parts[1] ?? project,
    location: parts[3] ?? "",
    uid: job.uid,
    state: job.status?.state,
    labels: stripInternalLabels(tagRecord(job.labels)),
    createTime: job.createTime,
  };
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["name", "jobId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return undefined;
      // Batch has no update API: any change is a new job.
      const changed =
        news.jobId !== olds.jobId ||
        news.location !== olds.location ||
        !sameJson(news.taskGroups, olds.taskGroups) ||
        !sameJson(news.allocationPolicy, olds.allocationPolicy) ||
        !sameJson(news.logsPolicy, olds.logsPolicy) ||
        !sameJson(news.notifications, olds.notifications) ||
        news.priority !== olds.priority ||
        !sameJson(news.labels ?? {}, olds.labels ?? {});
      if (!changed) return undefined;
      // An explicit id that stays the same can only be reused once the old job is gone.
      const sameId = news.jobId !== undefined && news.jobId === olds.jobId;
      return { action: "replace" as const, deleteFirst: sameId };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = output?.location ?? olds?.location ?? env.region;
      const jobId = yield* toJobId(id, olds?.jobId, output?.jobId);
      const existing = yield* getByName(output?.name ?? resourceName(env.project, location, jobId));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* batch.listProjectsLocationsJobs
          .pages({ parent: `projects/${env.project}/locations/-` })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.jobs ?? [])),
            Stream.filter((job) =>
              Object.keys(job.labels ?? {}).some((key) => key.startsWith("alchemy-")),
            ),
            Stream.map((job) => toAttrs(job, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = lastSegment(news.location ?? output?.location ?? env.region);
      const jobId = yield* toJobId(id, news.jobId, output?.jobId);
      const name = resourceName(env.project, location, jobId);

      // Observe
      let current = yield* getByName(output?.name ?? name);

      // Ensure: a job has nothing to sync after create.
      if (current === undefined) {
        current = yield* batch
          .createProjectsLocationsJobs({
            parent: `projects/${env.project}/locations/${location}`,
            jobId,
            body: {
              taskGroups: news.taskGroups,
              allocationPolicy: news.allocationPolicy,
              logsPolicy: news.logsPolicy,
              notifications: news.notifications,
              priority: news.priority,
              labels: { ...toLabels(news.labels), ...(yield* createInternalLabels(id)) },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
      }
      if (current === undefined) {
        return yield* new JobNotResolved({ resourceName: name });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* batch
        .deleteProjectsLocationsJobs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) {
        yield* waitForOperation(operation, (name) =>
          batch.getProjectsLocationsOperations({ name }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      // A deleted job lingers in DELETION_IN_PROGRESS while Batch tears down its VMs.
      yield* getByName(output.name).pipe(
        Effect.filterOrFail(
          (job) => job === undefined,
          () => new JobStillExists({ resourceName: output.name }),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.Batch.JobStillExists",
          times: 40,
          schedule: Schedule.spaced("15 seconds"),
        }),
      );
    }),
  });
