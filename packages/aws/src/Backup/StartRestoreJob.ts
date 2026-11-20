import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartRestoreJob` request with `IamRoleArn` defaulting to the bound
 * restore role.
 */
export interface StartRestoreJobRequest extends Omit<backup.StartRestoreJobInput, "IamRoleArn"> {
  /**
   * IAM role AWS Backup assumes to create the restored resource.
   * @default the restore role bound via `StartRestoreJob(role)`
   */
  IamRoleArn?: string;
}

/**
 * Runtime binding for the `StartRestoreJob` operation (IAM actions
 * `backup:StartRestoreJob` + `iam:PassRole` on the restore role) — restore a
 * recovery point from a deployed Function.
 *
 * The binding is constructed with the **restore role** (the IAM role AWS
 * Backup assumes to recreate the resource; its trust policy must allow
 * `backup.amazonaws.com`), injected as `IamRoleArn` unless the request
 * overrides it. `backup:StartRestoreJob` authorizes on the recovery point's
 * underlying resource ARN, so the grant is on `*`. Provide the
 * implementation with `Effect.provide(AWS.Backup.StartRestoreJobHttp)`.
 * ### Restoring Recovery Points
 * **Example:** Restore The Latest Recovery Point
 * ```typescript
 * const startRestoreJob = yield* AWS.Backup.StartRestoreJob(restoreRole);
 *
 * const job = yield* startRestoreJob({
 *   RecoveryPointArn: recoveryPointArn,
 *   Metadata: restoreMetadata,
 * });
 * yield* Effect.log(`restore job ${job.RestoreJobId} started`);
 * ```
 *
 * @binding
 */
export interface StartRestoreJob extends Binding.Service<
  StartRestoreJob,
  "AWS.Backup.StartRestoreJob",
  <R extends Role>(
    restoreRole: R,
  ) => Effect.Effect<
    (
      request: StartRestoreJobRequest,
    ) => Effect.Effect<backup.StartRestoreJobOutput, backup.StartRestoreJobError>
  >
> {}
export const StartRestoreJob = Binding.Service<StartRestoreJob>("AWS.Backup.StartRestoreJob");

export const StartRestoreJobHttp = Layer.effect(
  StartRestoreJob,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startRestoreJob = yield* AWSBindings.withCredentials(backup.startRestoreJob);

    return Effect.fn(function* <R extends Role>(restoreRole: R) {
      const RoleArn = yield* restoreRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Backup.StartRestoreJob(${restoreRole})`({
          policyStatements: [
            // StartRestoreJob authorizes on the recovery point's
            // underlying resource ARN (a snapshot ARN unknowable at
            // deploy time), so the grant is on `*`.
            {
              Effect: "Allow",
              Action: ["backup:StartRestoreJob"],
              Resource: ["*"],
            },
            // CRITICAL: without iam:PassRole on the restore role,
            // StartRestoreJob fails only at runtime with an AccessDenied.
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: [Output.interpolate`${restoreRole.roleArn}`],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "backup.amazonaws.com",
                },
              },
            },
          ],
        });
      }
      return Effect.fn(`AWS.Backup.StartRestoreJob(${restoreRole.LogicalId})`)(function* (
        request: StartRestoreJobRequest,
      ) {
        return yield* startRestoreJob({
          ...request,
          IamRoleArn: request.IamRoleArn ?? (yield* RoleArn),
        });
      });
    });
  }),
);
