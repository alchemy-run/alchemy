import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Role } from "../IAM/Role.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `StartBackupJob` request with `BackupVaultName` injected from the bound
 * {@link BackupVault} and `IamRoleArn` defaulting to the bound backup role.
 */
export interface StartBackupJobRequest extends Omit<
  backup.StartBackupJobInput,
  "BackupVaultName" | "IamRoleArn"
> {
  /**
   * IAM role AWS Backup assumes to create the backup.
   * @default the backup role bound via `StartBackupJob(vault, role)`
   */
  IamRoleArn?: string;
}

/**
 * Runtime binding for the `StartBackupJob` operation (IAM actions
 * `backup:StartBackupJob` on the vault ARN + `iam:PassRole` on the backup
 * role) — take an on-demand backup of any supported resource from a deployed
 * Function.
 *
 * The binding is constructed with the target {@link BackupVault} and the
 * **backup role** (the IAM role AWS Backup assumes to read the resource and
 * write the recovery point; its trust policy must allow
 * `backup.amazonaws.com`). Both are injected into every runtime request.
 * Provide the implementation with
 * `Effect.provide(AWS.Backup.StartBackupJobHttp)`.
 * ### Starting Backups
 * **Example:** On-Demand Backup Of A DynamoDB Table
 * ```typescript
 * // deploy time — bind the vault and the backup role
 * const startBackupJob = yield* AWS.Backup.StartBackupJob(vault, backupRole);
 *
 * // runtime — snapshot the table before a risky migration
 * const tableArn = yield* table.tableArn;
 * const job = yield* startBackupJob({
 *   ResourceArn: tableArn,
 *   Lifecycle: { DeleteAfterDays: 7 },
 * });
 * yield* Effect.log(`backup job ${job.BackupJobId} started`);
 * ```
 *
 * @binding
 */
export interface StartBackupJob extends Binding.Service<
  StartBackupJob,
  "AWS.Backup.StartBackupJob",
  <R extends Role>(
    vault: BackupVault,
    backupRole: R,
  ) => Effect.Effect<
    (
      request: StartBackupJobRequest,
    ) => Effect.Effect<backup.StartBackupJobOutput, backup.StartBackupJobError>
  >
> {}
export const StartBackupJob = Binding.Service<StartBackupJob>("AWS.Backup.StartBackupJob");

export const StartBackupJobHttp = Layer.effect(
  StartBackupJob,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startBackupJob = yield* AWSBindings.withCredentials(backup.startBackupJob);

    return Effect.fn(function* <R extends Role>(vault: BackupVault, backupRole: R) {
      const BackupVaultName = yield* vault.backupVaultName;
      const RoleArn = yield* backupRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Backup.StartBackupJob(${vault}, ${backupRole})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["backup:StartBackupJob"],
              Resource: [Output.interpolate`${vault.backupVaultArn}`],
            },
            // CRITICAL: without iam:PassRole on the backup role,
            // StartBackupJob fails only at runtime with an AccessDenied.
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: [Output.interpolate`${backupRole.roleArn}`],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "backup.amazonaws.com",
                },
              },
            },
          ],
        });
      }
      return Effect.fn(`AWS.Backup.StartBackupJob(${vault.LogicalId})`)(function* (
        request: StartBackupJobRequest,
      ) {
        return yield* startBackupJob({
          ...request,
          BackupVaultName: yield* BackupVaultName,
          IamRoleArn: request.IamRoleArn ?? (yield* RoleArn),
        });
      });
    });
  }),
);
