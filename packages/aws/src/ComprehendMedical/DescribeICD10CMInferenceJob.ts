import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `comprehendmedical:DescribeICD10CMInferenceJob` — get the properties and status of an asynchronous ICD-10-CM ontology linking job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:DescribeICD10CMInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.DescribeICD10CMInferenceJobHttp)`.
 *
 * ### Batch ICD-10-CM Inference Jobs
 * **Example:** Poll a Job's Status
 * ```typescript
 * // init
 * const describeICD10CMInferenceJob = yield* AWS.ComprehendMedical.DescribeICD10CMInferenceJob();
 *
 * // runtime
 * const status = yield* describeICD10CMInferenceJob({ JobId: jobId });
 * console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
 * ```
 *
 * @binding
 */
export interface DescribeICD10CMInferenceJob extends Binding.Service<
  DescribeICD10CMInferenceJob,
  "AWS.ComprehendMedical.DescribeICD10CMInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.DescribeICD10CMInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.DescribeICD10CMInferenceJobResponse,
      comprehendmedical.DescribeICD10CMInferenceJobError
    >
  >
> {}
export const DescribeICD10CMInferenceJob = Binding.Service<DescribeICD10CMInferenceJob>(
  "AWS.ComprehendMedical.DescribeICD10CMInferenceJob",
);

export const DescribeICD10CMInferenceJobHttp = Layer.effect(
  DescribeICD10CMInferenceJob,
  makeComprehendMedicalHttpBinding({
    capability: "DescribeICD10CMInferenceJob",
    iamActions: ["comprehendmedical:DescribeICD10CMInferenceJob"],
    operation: comprehendmedical.describeICD10CMInferenceJob,
  }),
);
