import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartJob` request with `ExecutionRoleArn` injected from the bound
 * execution role (an explicit `ExecutionRoleArn` overrides it).
 */
export interface StartJobRequest extends Omit<
  location.StartJobRequest,
  "ExecutionRoleArn"
> {
  ExecutionRoleArn?: string;
}

/**
 * Starts a Location batch metadata job (e.g. batch address validation) that
 * reads its input from and writes its results to S3.
 *
 * Runtime binding for the `StartJob` operation (IAM action `geo:StartJob`).
 * The binding is constructed with the **execution role** Location assumes to
 * read/write the S3 locations (its trust policy must allow
 * `location.amazonaws.com`); the role's ARN is injected as
 * `ExecutionRoleArn` and the deploy-time half additionally grants
 * `iam:PassRole` on the role — without it, `StartJob` fails only at runtime
 * with an access-denied error. Provide the implementation with
 * `Effect.provide(AWS.Location.StartJobHttp)`.
 *
 * @binding
 * @section Managing Batch Jobs
 * @example Start a Batch Address Validation Job
 * ```typescript
 * const startJob = yield* Location.StartJob(executionRole);
 *
 * const job = yield* startJob({
 *   Action: "ValidateAddress",
 *   InputOptions: { Format: "CSV", Location: "s3://my-bucket/input.csv" },
 *   OutputOptions: { Format: "CSV", Location: "s3://my-bucket/output/" },
 * });
 * // job.JobId → poll with Location.GetJob
 * ```
 */
export interface StartJob extends Binding.Service<
  StartJob,
  "AWS.Location.StartJob",
  (
    executionRole: Role,
  ) => Effect.Effect<
    (
      request: StartJobRequest,
    ) => Effect.Effect<location.StartJobResponse, location.StartJobError>
  >
> {}
export const StartJob = Binding.Service<StartJob>("AWS.Location.StartJob");
