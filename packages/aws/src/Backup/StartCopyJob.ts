import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Role } from "../IAM/Role.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `StartCopyJob` request with `SourceBackupVaultName` injected from the
 * bound {@link BackupVault} and `IamRoleArn` defaulting to the bound copy
 * role.
 */
export interface StartCopyJobRequest extends Omit<
  backup.StartCopyJobInput,
  "SourceBackupVaultName" | "IamRoleArn"
> {
  /**
   * IAM role AWS Backup assumes to perform the copy.
   * @default the copy role bound via `StartCopyJob(sourceVault, role)`
   */
  IamRoleArn?: string;
}

/**
 * Runtime binding for the `StartCopyJob` operation (IAM actions
 * `backup:StartCopyJob` + `backup:CopyIntoBackupVault` + `iam:PassRole` on
 * the copy role) — copy a recovery point from the bound source vault to a
 * destination vault (e.g. cross-region or cross-account disaster recovery).
 *
 * The binding is constructed with the **source** {@link BackupVault} and the
 * **copy role** (its trust policy must allow `backup.amazonaws.com`); the
 * destination vault ARN is a runtime request field. Provide the
 * implementation with `Effect.provide(AWS.Backup.StartCopyJobHttp)`.
 * ### Copying Recovery Points
 * **Example:** Copy A Recovery Point To A DR Vault
 * ```typescript
 * const startCopyJob = yield* AWS.Backup.StartCopyJob(vault, backupRole);
 *
 * const job = yield* startCopyJob({
 *   RecoveryPointArn: recoveryPointArn,
 *   DestinationBackupVaultArn: drVaultArn,
 * });
 * yield* Effect.log(`copy job ${job.CopyJobId} started`);
 * ```
 *
 * @binding
 */
export interface StartCopyJob extends Binding.Service<
  StartCopyJob,
  "AWS.Backup.StartCopyJob",
  <R extends Role>(
    sourceVault: BackupVault,
    copyRole: R,
  ) => Effect.Effect<
    (
      request: StartCopyJobRequest,
    ) => Effect.Effect<backup.StartCopyJobOutput, backup.StartCopyJobError>
  >
> {}
export const StartCopyJob = Binding.Service<StartCopyJob>("AWS.Backup.StartCopyJob");

export const StartCopyJobHttp = Layer.effect(
  StartCopyJob,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startCopyJob = yield* AWSBindings.withCredentials(backup.startCopyJob);

    return Effect.fn(function* <R extends Role>(sourceVault: BackupVault, copyRole: R) {
      const SourceBackupVaultName = yield* sourceVault.backupVaultName;
      const RoleArn = yield* copyRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Backup.StartCopyJob(${sourceVault}, ${copyRole})`({
          policyStatements: [
            // StartCopyJob authorizes on the recovery point's underlying
            // resource ARN and CopyIntoBackupVault on the destination
            // vault — both runtime request fields, so the grant is `*`.
            {
              Effect: "Allow",
              Action: ["backup:StartCopyJob", "backup:CopyIntoBackupVault"],
              Resource: ["*"],
            },
            // CRITICAL: without iam:PassRole on the copy role,
            // StartCopyJob fails only at runtime with an AccessDenied.
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: [Output.interpolate`${copyRole.roleArn}`],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "backup.amazonaws.com",
                },
              },
            },
          ],
        });
      }
      return Effect.fn(`AWS.Backup.StartCopyJob(${sourceVault.LogicalId})`)(function* (
        request: StartCopyJobRequest,
      ) {
        return yield* startCopyJob({
          ...request,
          SourceBackupVaultName: yield* SourceBackupVaultName,
          IamRoleArn: request.IamRoleArn ?? (yield* RoleArn),
        });
      });
    });
  }),
);
