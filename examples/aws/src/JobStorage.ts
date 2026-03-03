import * as S3 from "alchemy-effect/AWS/S3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

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
        Effect.orDie,
      );

    const getJob = (jobId: string) =>
      getObject({
        Key: jobId,
      }).pipe(
        Effect.map((item) => item.Body as any),
        Effect.orDie,
      );

    return JobStorage.of({
      bucket,
      putJob,
      getJob,
    });
  }),
);
