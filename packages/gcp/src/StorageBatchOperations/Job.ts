import * as sbo from "@distilled.cloud/gcp/storagebatchoperations_v1";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { GcpEnvironment } from "../Environment.ts";
import { updateIamMembership } from "../IamPolicy.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";
import { projectNumberOf } from "../ResourceManager/internal.ts";

const LOCATION = "global";
const MAX_JOB_ID_LENGTH = 63;

/** Objects a job acts on: a bucket and either prefixes or a manifest of object names. */
export type JobBucket = {
  /** Bucket name. */
  bucket: string;
  /** Act on objects whose names start with one of these prefixes; `[""]` is every object. */
  includedObjectPrefixes?: string[];
  /** A CSV manifest (`gs://bucket/manifest.csv`) listing `bucket,name[,generation]` rows. */
  manifestLocation?: string;
};

export type JobProps = {
  /**
   * Job id. If omitted, a unique id is generated. Immutable — changing it
   * replaces the job.
   */
  jobId?: string;
  /** Description. */
  description?: string;
  /** The bucket and objects the job acts on. */
  bucket: JobBucket;
  /** Delete the objects. Set exactly one of the operations. */
  deleteObject?: sbo.DeleteObject;
  /** Set metadata on the objects (content type, cache control, custom metadata). */
  putMetadata?: sbo.PutMetadata;
  /** Set or release event-based and temporary holds. */
  putObjectHold?: sbo.PutObjectHold;
  /** Rewrite the objects to a new storage class or KMS key. */
  rewriteObject?: sbo.RewriteObject;
  /** Which actions and outcomes the job logs to Cloud Logging. */
  loggingConfig?: sbo.LoggingConfig;
  /**
   * Report what the job would do without changing any object.
   * @default false
   */
  dryRun?: boolean;
};

export type Job = Resource<
  "GCP.StorageBatchOperations.Job",
  JobProps,
  {
    /** Full name `projects/{project}/locations/global/jobs/{job}`. */
    name: string;
    /** Job id. */
    jobId: string;
    /** Project id. */
    project: string;
    /** `QUEUED`, `RUNNING`, `SUCCEEDED`, `CANCELED` or `FAILED`. */
    state: string | undefined;
    /** When the job was created. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Storage batch operations job: one operation (delete, set metadata, set
 * holds, rewrite) applied to many objects in a bucket, selected by prefix
 * or listed in a manifest.
 *
 * Batch operations need [Storage Intelligence](https://cloud.google.com/storage/docs/storage-intelligence/overview)
 * enabled on the bucket's project.
 *
 * Jobs run as the project's Storage Batch Operations service agent, so the
 * provider grants it `roles/storage.objectUser` on the bucket. The grant
 * stays when the job is deleted, since other jobs may share it.
 *
 * A job runs once. Jobs can't be edited, so changing any prop replaces the
 * job, which runs it again on the same objects. Deleting the job cancels it
 * first if it is still running; it never undoes what the job did.
 *
 * ### Changing Many Objects
 * **Example:** Set the content type of every object under a prefix
 * ```typescript
 * yield* GCP.StorageBatchOperations.Job("Retype", {
 *   bucket: { bucket: assets.bucketName, includedObjectPrefixes: ["images/"] },
 *   putMetadata: { contentType: "image/webp" },
 * });
 * ```
 *
 * **Example:** A dry run of a delete
 * ```typescript
 * yield* GCP.StorageBatchOperations.Job("Purge", {
 *   bucket: { bucket: logs.bucketName, includedObjectPrefixes: ["2025/"] },
 *   deleteObject: { permanentObjectDeletionEnabled: false },
 *   dryRun: true,
 * });
 * ```
 *
 * @resource
 * @category Storage Batch Operations
 */
export const Job = Resource<Job>("GCP.StorageBatchOperations.Job");

export class JobNotResolved extends Data.TaggedError("GCP.StorageBatchOperations.JobNotResolved")<{
  resourceName: string;
}> {}

const lastSegment = (value: string) => value.replace(/\/+$/, "").split("/").pop() ?? value;

const resourceName = (project: string, jobId: string) =>
  `projects/${project}/locations/${LOCATION}/jobs/${jobId}`;

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
    return (generated || "job").slice(0, MAX_JOB_ID_LENGTH).replace(/-+$/, "");
  });

const getByName = (name: string) =>
  sbo.getProjectsLocationsJobs({ name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (job: sbo.Job, project: string): Job["Attributes"] => {
  const name = job.name ?? "";
  return {
    name,
    jobId: lastSegment(name),
    project: name.split("/")[1] ?? project,
    state: job.state,
    createTime: job.createTime,
  };
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const TERMINAL = new Set(["SUCCEEDED", "CANCELED", "FAILED"]);

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["name", "jobId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return undefined;
      // Jobs have no update API: any change is a new job.
      if (sameJson(news, olds)) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: news.jobId !== undefined && news.jobId === olds.jobId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toJobId(id, olds?.jobId, output?.jobId);
      const existing = yield* getByName(output?.name ?? resourceName(env.project, jobId));
      // Jobs carry no labels: an existing job under our generated id is ours.
      return existing === undefined ? undefined : toAttrs(existing, env.project);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toJobId(id, news.jobId, output?.jobId);
      const name = resourceName(env.project, jobId);

      // Observe
      let current = yield* getByName(output?.name ?? name);

      // Ensure: a job has nothing to sync after create.
      if (current === undefined) {
        // The job reads and changes objects as the service agent.
        const number = yield* projectNumberOf(env.project);
        yield* updateIamMembership({
          kind: "storage.bucket",
          name: news.bucket.bucket,
          member: `service-${number}@gcp-sa-storagebatchoperations.iam.gserviceaccount.com`,
          add: ["roles/storage.objectUser"],
        });
        const operation = yield* sbo
          .createProjectsLocationsJobs({
            parent: `projects/${env.project}/locations/${LOCATION}`,
            jobId,
            body: {
              description: news.description,
              bucketList: {
                buckets: [
                  {
                    bucket: news.bucket.bucket,
                    prefixList: news.bucket.includedObjectPrefixes
                      ? { includedObjectPrefixes: news.bucket.includedObjectPrefixes }
                      : undefined,
                    manifest: news.bucket.manifestLocation
                      ? { manifestLocation: news.bucket.manifestLocation }
                      : undefined,
                  },
                ],
              },
              deleteObject: news.deleteObject,
              putMetadata: news.putMetadata,
              putObjectHold: news.putObjectHold,
              rewriteObject: news.rewriteObject,
              loggingConfig: news.loggingConfig,
              dryRun: news.dryRun,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        // The operation finishes when the job does; the job exists as soon as it is accepted.
        if (operation !== undefined && operation.done) {
          yield* waitForOperation(operation, (op) =>
            sbo.getProjectsLocationsOperations({ name: op }),
          );
        }
        current = yield* getByName(name);
      }
      if (current === undefined) {
        return yield* new JobNotResolved({ resourceName: name });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const job = yield* getByName(output.name);
      if (job === undefined) return;
      // A running job can only be deleted once canceled.
      if (!TERMINAL.has(job.state ?? "")) {
        yield* sbo
          .cancelProjectsLocationsJobs({ name: output.name })
          .pipe(Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void));
      }
      yield* sbo
        .deleteProjectsLocationsJobs({ name: output.name, force: true })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
