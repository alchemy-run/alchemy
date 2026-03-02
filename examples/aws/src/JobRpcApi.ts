import { Effect, Schema } from "effect";
import {
  Rpc,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/unstable/rpc";
import { Job, JobId } from "./Job.ts";
import { JobStorage } from "./JobStorage.ts";

export class JobNotFound extends Schema.TaggedClass<JobNotFound>()(
  "JobNotFound",
  { jobId: JobId },
) {}

const getJob = Rpc.make("getJob", {
  success: Job,
  error: JobNotFound,
  payload: {
    jobId: JobId,
  },
});

const createJob = Rpc.make("createJob", {
  success: JobId,
  payload: {
    content: Schema.String,
  },
});

export class JobRpcs extends RpcGroup.make(getJob, createJob) {}

export const JobRpcsLive = JobRpcs.toLayer(
  Effect.gen(function* () {
    const jobService = yield* JobStorage;

    return {
      getJob: ({ jobId }) =>
        jobService
          .getJob(jobId)
          .pipe(
            Effect.flatMap((job) =>
              job
                ? Effect.succeed(job)
                : Effect.fail(new JobNotFound({ jobId })),
            ),
          ),
      createJob: ({ content }) =>
        jobService
          .putJob({
            id: "TODO",
            content,
          })
          .pipe(Effect.map((job) => job.id)),
    };
  }),
);

export const JobRpcHttpEffect = RpcServer.toHttpEffect(JobRpcs).pipe(
  Effect.provide(JobRpcsLive),
  Effect.provide(RpcSerialization.layerJson),
);
