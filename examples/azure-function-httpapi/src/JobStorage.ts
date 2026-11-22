import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { JobStoreUnavailable, type Job } from "./Job.ts";
import { JOB_PARTITION, Jobs } from "./resources.ts";

/**
 * Where jobs live. The API depends on this interface, not on Azure, so a
 * test or another cloud can swap the implementation.
 */
export class JobStorage extends Context.Service<
  JobStorage,
  {
    putJob(job: Job): Effect.Effect<Job, JobStoreUnavailable, RuntimeContext>;
    getJob(id: string): Effect.Effect<Job | undefined, JobStoreUnavailable, RuntimeContext>;
    listJobs(): Effect.Effect<readonly Job[], JobStoreUnavailable, RuntimeContext>;
    deleteJob(id: string): Effect.Effect<void, JobStoreUnavailable, RuntimeContext>;
  }
>()("JobStorage") {}

/** Map a typed Table storage error to the API's error, keeping only its tag. */
const unavailable = (error: Azure.Storage.TableEntityError) =>
  new JobStoreUnavailable({ reason: error._tag });

const toJob = (entity: Azure.Storage.TableEntityRecord): Job => ({
  id: entity.RowKey,
  content: typeof entity.content === "string" ? entity.content : "",
  createdAt: typeof entity.createdAt === "string" ? entity.createdAt : "",
});

/**
 * {@link JobStorage} on Azure Table storage. `TableReadWrite` grants the
 * Function's managed identity a custom role on the `Jobs` table only (read,
 * add, update, and delete entities) and returns a typed client.
 */
export const JobStorageTable = Layer.effect(
  JobStorage,
  Effect.gen(function* () {
    const table = yield* Jobs;
    const jobs = yield* Azure.Storage.TableReadWrite(table);

    return JobStorage.of({
      putJob: (job) =>
        jobs
          .insert({
            PartitionKey: JOB_PARTITION,
            RowKey: job.id,
            content: job.content,
            createdAt: job.createdAt,
          })
          .pipe(Effect.as(job), Effect.mapError(unavailable)),
      getJob: (id) =>
        jobs.get(JOB_PARTITION, id).pipe(
          Effect.map((entity) => (entity === undefined ? undefined : toJob(entity))),
          Effect.mapError(unavailable),
        ),
      // One page (up to 1,000 jobs) keeps the example short. Pass
      // `continuation` back to `query` to read more.
      listJobs: () =>
        jobs.query({ filter: `PartitionKey eq '${JOB_PARTITION}'` }).pipe(
          Effect.map((page) => page.entities.map(toJob)),
          Effect.mapError(unavailable),
        ),
      // Without an ETag a missing entity succeeds, so DELETE is idempotent.
      deleteJob: (id) => jobs.delete(JOB_PARTITION, id).pipe(Effect.mapError(unavailable)),
    });
  }),
).pipe(Layer.provide(Azure.Storage.TableReadWriteHttp));
