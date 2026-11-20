import * as batch from "@distilled.cloud/aws/batch";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { JobDefinition } from "./JobDefinition.ts";
import type { JobQueue } from "./JobQueue.ts";

/**
 * The queue and job definition are injected by the binding; everything else
 * (name, parameters, container overrides, ...) is the raw distilled request.
 */
export interface SubmitJobRequest extends Omit<
  batch.SubmitJobRequest,
  "jobQueue" | "jobDefinition"
> {}

/**
 * Submit a job to an AWS Batch job queue against a bound job definition —
 * fire-and-forget heavy work from a Lambda or Task.
 *
 * ### Submitting Jobs
 * **Example:** Submit from a Lambda
 * ```typescript
 * const submitJob = yield* Batch.SubmitJob(queue, jobDef);
 * const { jobId } = yield* submitJob({
 *   jobName: "nightly-export",
 *   containerOverrides: { command: ["echo", "hello"] },
 * });
 * ```
 *
 * @binding
 */
export interface SubmitJob extends Binding.Service<
  SubmitJob,
  "AWS.Batch.SubmitJob",
  (
    queue: JobQueue,
    jobDefinition: JobDefinition,
  ) => Effect.Effect<
    (request: SubmitJobRequest) => Effect.Effect<batch.SubmitJobResponse, batch.SubmitJobError>
  >
> {}
export const SubmitJob = Binding.Service<SubmitJob>("AWS.Batch.SubmitJob");

export const SubmitJobHttp = Layer.effect(
  SubmitJob,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const submitJob = yield* AWSBindings.withCredentials(batch.submitJob);

    return Effect.fn(function* (queue: JobQueue, jobDefinition: JobDefinition) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const JobQueueArn = yield* queue.jobQueueArn;
      const JobDefinitionArn = yield* jobDefinition.jobDefinitionArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Batch.SubmitJob(${queue}, ${jobDefinition})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["batch:SubmitJob"],
              Resource: [queue.jobQueueArn, jobDefinition.jobDefinitionArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Batch.SubmitJob(${queue.LogicalId}, ${jobDefinition.LogicalId})`)(
        function* (request: SubmitJobRequest) {
          const jobQueueArn = yield* JobQueueArn;
          const jobDefinitionArn = yield* JobDefinitionArn;
          return yield* submitJob({
            ...request,
            jobQueue: jobQueueArn,
            jobDefinition: jobDefinitionArn,
          });
        },
      );
    });
  }),
);
