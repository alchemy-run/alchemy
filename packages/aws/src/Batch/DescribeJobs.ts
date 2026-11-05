import * as batch from "@distilled.cloud/aws/batch";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBatchJobHttpBinding } from "./BindingHttp.ts";
import type { JobQueue } from "./JobQueue.ts";

export interface DescribeJobsRequest extends batch.DescribeJobsRequest {}

/**
 * Describe submitted AWS Batch jobs (status polling from runtime code).
 * `batch:DescribeJobs` has no resource-level IAM, so the policy is
 * service-scoped; the queue anchors the binding's identity.
 *
 * ### Describing Jobs
 * **Example:** Poll a job's status
 * ```typescript
 * const describeJobs = yield* Batch.DescribeJobs(queue);
 * const { jobs } = yield* describeJobs({ jobs: [jobId] });
 * const status = jobs?.[0]?.status;
 * ```
 *
 * @binding
 */
export interface DescribeJobs extends Binding.Service<
  DescribeJobs,
  "AWS.Batch.DescribeJobs",
  (
    queue: JobQueue,
  ) => Effect.Effect<
    (
      request: DescribeJobsRequest,
    ) => Effect.Effect<batch.DescribeJobsResponse, batch.DescribeJobsError>
  >
> {}
export const DescribeJobs = Binding.Service<DescribeJobs>("AWS.Batch.DescribeJobs");

export const DescribeJobsHttp = Layer.effect(
  DescribeJobs,
  // batch:DescribeJobs does not support resource-level IAM.
  makeBatchJobHttpBinding({
    tag: "AWS.Batch.DescribeJobs",
    operation: batch.describeJobs,
    actions: ["batch:DescribeJobs"],
  }),
);
