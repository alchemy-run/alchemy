import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `comprehend:StopDominantLanguageDetectionJob` — request termination
 * of an in-progress asynchronous dominant-language detection job. The job moves to
 * `STOP_REQUESTED` and then `STOPPED`; documents already processed are
 * written to the output location.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * ### Stopping Analysis Jobs
 * **Example:** Stop a Running DominantLanguageDetection Job
 * ```typescript
 * // init
 * const stopDominantLanguageDetectionJob = yield* AWS.Comprehend.StopDominantLanguageDetectionJob();
 *
 * // runtime
 * const result = yield* stopDominantLanguageDetectionJob({ JobId: jobId });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 *
 * @binding
 */
export interface StopDominantLanguageDetectionJob extends Binding.Service<
  StopDominantLanguageDetectionJob,
  "AWS.Comprehend.StopDominantLanguageDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.StopDominantLanguageDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StopDominantLanguageDetectionJobResponse,
      comprehend.StopDominantLanguageDetectionJobError
    >
  >
> {}
export const StopDominantLanguageDetectionJob = Binding.Service<StopDominantLanguageDetectionJob>(
  "AWS.Comprehend.StopDominantLanguageDetectionJob",
);

export const StopDominantLanguageDetectionJobHttp = Layer.effect(
  StopDominantLanguageDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopDominantLanguageDetectionJob",
    operation: comprehend.stopDominantLanguageDetectionJob,
    actions: ["comprehend:StopDominantLanguageDetectionJob"],
  }),
);
