import type * as youtubereporting from "@distilled.cloud/gcp/youtubereporting_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Job } from "./Job.ts";

export interface GetJobRequest extends Omit<
  youtubereporting.GetJobsRequest,
  "jobId"
> {}

/**
 * Runtime binding for YouTube Reporting `jobs.get`.
 *
 * Bind this operation to a {@link Job} in a Function/Action init
 * phase. Provide {@link GetJobHttp}.
 *
 * ### Reading Jobs
 * **Example:** Read job metadata
 * ```typescript
 * const getJob = yield* GCP.Youtubereporting.GetJob(job);
 * const metadata = yield* getJob({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Youtubereporting
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "GCP.Youtubereporting.GetJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request: GetJobRequest,
    ) => Effect.Effect<
      youtubereporting.Job,
      youtubereporting.GetJobsError,
      RuntimeContext
    >
  >
> {}

export const GetJob = Binding.Service<GetJob>("GCP.Youtubereporting.GetJob");
