import * as S3 from "alchemy-effect/AWS/S3";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";

import type { Job } from "./Job.ts";

export class PutJobError extends Data.TaggedError("PutJobError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class GetJobError extends Data.TaggedError("GetJobError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class JobStorage extends ServiceMap.Service<
  JobStorage,
  {
    bucket: S3.Bucket;
    putJob(job: Job): Effect.Effect<Job, PutJobError>;
    getJob(jobId: string): Effect.Effect<Job | undefined, GetJobError>;
  }
>()("JobStorage") {}

export const JobStorageLive = Layer.effect(
  JobStorage,
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("JobsBucket");

    const getObject = yield* S3.GetObject.bind(bucket);
    const putObject = yield* S3.PutObject.bind(bucket);

    const putJob = (job: Job) =>
      putObject({
        Key: job.id,
        Body: JSON.stringify(job),
      }).pipe(
        Effect.map(() => job),
        Effect.tapError(Console.log),
        Effect.catchCause((cause) =>
          Effect.fail(
            new PutJobError({
              message: `Failed to store job "${job.id}": ${cause}`,
              cause,
            }),
          ),
        ),
      );

    const getJob = (jobId: string) =>
      getObject({
        Key: jobId,
      }).pipe(
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
        Effect.flatMap(
          (item) =>
            item?.Body?.pipe(
              Stream.decodeText,
              Stream.mkString,
              Effect.flatMap((body) =>
                Effect.try({
                  try: () => JSON.parse(body) as Job,
                  catch: (cause) =>
                    new GetJobError({
                      message: `Failed to parse job "${jobId}": ${cause}`,
                      cause,
                    }),
                }),
              ),
            ) ?? Effect.succeed(undefined),
        ),
        Effect.tapError(Console.log),
        Effect.catchCause((cause) =>
          Effect.fail(
            new GetJobError({
              message: `Failed to load job "${jobId}": ${cause}`,
              cause,
            }),
          ),
        ),
      );

    return JobStorage.of({
      bucket,
      putJob,
      getJob,
    });
  }),
);
