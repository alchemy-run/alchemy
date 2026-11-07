import * as location from "@distilled.cloud/aws/location";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartJob` request with `ExecutionRoleArn` injected from the bound
 * execution role.
 */
export interface StartJobRequest extends Omit<location.StartJobRequest, "ExecutionRoleArn"> {}

/**
 * Starts a Location batch metadata job (e.g. batch address validation over
 * an S3 input file).
 *
 * Runtime binding for the `StartJob` operation (IAM action `geo:StartJob`).
 * Bind the IAM {@link Role} Location assumes to read the S3 input and write
 * the S3 output — its ARN is injected as `ExecutionRoleArn` and the host is
 * additionally granted `iam:PassRole` on it. Jobs are named at runtime so
 * the `geo:StartJob` grant is on `*`. Provide the implementation with
 * `Effect.provide(AWS.Location.StartJobHttp)`.
 *
 * ### Managing Batch Jobs
 * **Example:** Start a Batch Job
 * ```typescript
 * const startJob = yield* Location.StartJob(jobsRole);
 *
 * const job = yield* startJob({
 *   Action: "ValidateAddress",
 *   InputOptions: { Format: "CSV", Location: "s3://my-bucket/addresses.csv" },
 *   OutputOptions: { Format: "CSV", Location: "s3://my-bucket/results/" },
 * });
 * // job.JobId → poll with Location.GetJob
 * ```
 *
 * @binding
 */
export interface StartJob extends Binding.Service<
  StartJob,
  "AWS.Location.StartJob",
  (
    executionRole: Role,
  ) => Effect.Effect<
    (request: StartJobRequest) => Effect.Effect<location.StartJobResponse, location.StartJobError>
  >
> {}
export const StartJob = Binding.Service<StartJob>("AWS.Location.StartJob");

/**
 * Bespoke (not via `BindingHttp.ts`): StartJob is the one Location binding
 * that injects an identifier from a *foreign* resource (the IAM execution
 * role) and needs a second `iam:PassRole` grant alongside the `geo:` action.
 */
export const StartJobHttp = Layer.effect(
  StartJob,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startJob = yield* AWSBindings.withCredentials(location.startJob);

    return Effect.fn(function* (executionRole: Role) {
      const RoleArn = yield* executionRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Location.StartJob(${executionRole})`({
          policyStatements: [
            // Jobs are named at runtime, so their ARNs are unknowable at
            // deploy time.
            {
              Effect: "Allow",
              Action: ["geo:StartJob"],
              Resource: ["*"],
            },
            // CRITICAL: without iam:PassRole on the execution role,
            // StartJob fails only at runtime with an AccessDenied.
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: [Output.interpolate`${executionRole.roleArn}`],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "location.amazonaws.com",
                },
              },
            },
          ],
        });
      }
      return Effect.fn(`AWS.Location.StartJob(${executionRole.LogicalId})`)(function* (
        request: StartJobRequest,
      ) {
        return yield* startJob({
          ...request,
          ExecutionRoleArn: yield* RoleArn,
        });
      });
    });
  }),
);
