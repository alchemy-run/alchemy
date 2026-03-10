import * as S3 from "alchemy-effect/AWS/S3";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";

import type { Job } from "./Job.ts";

export class JobStorage extends ServiceMap.Service<
  JobStorage,
  {
    bucket: S3.Bucket;
    putJob(job: Job): Effect.Effect<Job>;
    getJob(jobId: string): Effect.Effect<Job | undefined>;
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
        Effect.orDie,
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
              Effect.map(JSON.parse),
            ) ?? Effect.succeed(undefined),
        ),
        Effect.tapError(Console.log),
        Effect.orDie,
      );

    return JobStorage.of({
      bucket,
      putJob,
      getJob,
    });
  }),
);
