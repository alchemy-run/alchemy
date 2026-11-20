import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import type { Job } from "./Job.ts";

export interface PauseJobRequest extends Omit<
  scheduler.PauseProjectsLocationsJobsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Scheduler `jobs.pause`.
 *
 * Bind this operation to a {@link Job} in a Function/Action init phase.
 * Provide {@link PauseJobHttp}.
 *
 * Grants `roles/cloudscheduler.admin` on the project: it is the only
 * predefined role with `cloudscheduler.jobs.pause`, and Cloud Scheduler has
 * neither per-job IAM policies nor IAM Conditions on `resource.name`.
 *
 * ### Pausing Jobs
 * **Example:** Pause the bound job
 * ```typescript
 * const pauseJob = yield* GCP.CloudScheduler.PauseJob(ping);
 * yield* pauseJob();
 * ```
 *
 * @binding
 * @category CloudScheduler
 */
export interface PauseJob extends Binding.Service<
  PauseJob,
  "GCP.CloudScheduler.PauseJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: PauseJobRequest,
    ) => Effect.Effect<scheduler.Job, scheduler.PauseProjectsLocationsJobsError, RuntimeContext>
  >
> {}

export const PauseJob = Binding.Service<PauseJob>("GCP.CloudScheduler.PauseJob");

/**
 * HTTP implementation of {@link PauseJob}.
 *
 * Grants `roles/cloudscheduler.admin` on the project because it is the
 * only predefined role with `cloudscheduler.jobs.pause`, and Cloud Scheduler
 * supports neither per-job IAM policies nor IAM Conditions on
 * `resource.name`.
 *
 * @layer
 * @provides GCP.CloudScheduler.PauseJob
 */
export const PauseJobHttp: Layer.Layer<PauseJob, never, Credentials | HttpClient.HttpClient> =
  Layer.effect(
    PauseJob,
    makeJobHttpBinding<
      scheduler.PauseProjectsLocationsJobsRequest,
      scheduler.Job,
      scheduler.PauseProjectsLocationsJobsError
    >({
      tag: "GCP.CloudScheduler.PauseJob",
      iam: { role: "roles/cloudscheduler.admin" },
      operation: scheduler.pauseProjectsLocationsJobs,
    }),
  );
