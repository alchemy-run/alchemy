import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Job } from "./Job.ts";

export interface RunJobRequest extends Omit<cloudrun.RunProjectsLocationsJobsRequest, "name"> {}

/**
 * Runtime binding for Cloud Run `jobs.run`.
 *
 * Triggers a new execution of the bound {@link Job}. Provide
 * {@link RunJobHttp}.
 *
 * ### Running Jobs
 * **Example:** Trigger an execution
 * ```typescript
 * const runJob = yield* GCP.Run.RunJob(job);
 * yield* runJob();
 * ```
 *
 * **Example:** Override task count
 * ```typescript
 * const runJob = yield* GCP.Run.RunJob(job);
 * yield* runJob({
 *   body: { overrides: { taskCount: 1 } },
 * });
 * ```
 *
 * @binding
 * @category Run
 */
export interface RunJob extends Binding.Service<
  RunJob,
  "GCP.Run.RunJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: RunJobRequest,
    ) => Effect.Effect<
      cloudrun.GoogleLongrunningOperation,
      cloudrun.RunProjectsLocationsJobsError,
      RuntimeContext
    >
  >
> {}

export const RunJob = Binding.Service<RunJob>("GCP.Run.RunJob");

/**
 * HTTP implementation of {@link RunJob}.
 *
 * @layer
 * @provides GCP.Run.RunJob
 */
export const RunJobHttp = Layer.effect(
  RunJob,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(cloudrun.runProjectsLocationsJobs);
    return Effect.fn(function* <T extends Job>(job: T) {
      const name = yield* job.name;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Run.RunJob(${job})`({
          iam: [
            // runWithOverrides: RunJobRequest accepts `body.overrides`.
            grantFor({ role: "roles/run.jobsExecutorWithOverrides", on: "run.job" }, job.name),
          ],
        });
      }
      return Effect.fn(`GCP.Run.RunJob(${job.LogicalId})`)(function* (request?: RunJobRequest) {
        return yield* run({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
