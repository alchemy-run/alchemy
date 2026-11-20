import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import type { Job } from "./Job.ts";

export interface RunJobRequest extends Omit<scheduler.RunProjectsLocationsJobsRequest, "name"> {}

/**
 * Runtime binding for Cloud Scheduler `jobs.run`.
 *
 * Forces an immediate dispatch even if the job is already running. Bind this
 * operation to a {@link Job} in a Function/Action init phase. Provide
 * {@link RunJobHttp}.
 *
 * ### Running Jobs
 * **Example:** Run the bound job now
 * ```typescript
 * const runJob = yield* GCP.CloudScheduler.RunJob(ping);
 * yield* runJob();
 * ```
 *
 * @binding
 * @category CloudScheduler
 */
export interface RunJob extends Binding.Service<
  RunJob,
  "GCP.CloudScheduler.RunJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: RunJobRequest,
    ) => Effect.Effect<scheduler.Job, scheduler.RunProjectsLocationsJobsError, RuntimeContext>
  >
> {}

export const RunJob = Binding.Service<RunJob>("GCP.CloudScheduler.RunJob");

/**
 * HTTP implementation of {@link RunJob}.
 *
 * @layer
 * @provides GCP.CloudScheduler.RunJob
 */
export const RunJobHttp: Layer.Layer<RunJob, never, Credentials | HttpClient.HttpClient> =
  Layer.effect(
    RunJob,
    makeJobHttpBinding<
      scheduler.RunProjectsLocationsJobsRequest,
      scheduler.Job,
      scheduler.RunProjectsLocationsJobsError
    >({
      tag: "GCP.CloudScheduler.RunJob",
      // Cloud Scheduler has no resource-level IAM.
      iam: { role: "roles/cloudscheduler.jobRunner" },
      operation: scheduler.runProjectsLocationsJobs,
    }),
  );
