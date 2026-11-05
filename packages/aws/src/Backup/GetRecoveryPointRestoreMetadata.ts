import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { BackupVault } from "./BackupVault.ts";
import { makeBackupVaultHttpBinding } from "./BindingHttp.ts";

/**
 * `GetRecoveryPointRestoreMetadata` request with `BackupVaultName` injected
 * from the bound {@link BackupVault}.
 */
export interface GetRecoveryPointRestoreMetadataRequest extends Omit<
  backup.GetRecoveryPointRestoreMetadataInput,
  "BackupVaultName"
> {}

/**
 * Runtime binding for the `GetRecoveryPointRestoreMetadata` operation (IAM
 * action `backup:GetRecoveryPointRestoreMetadata`).
 *
 * Returns the restore metadata for a recovery point in the bound
 * {@link BackupVault} — the key/value set passed to `StartRestoreJob` as its
 * `Metadata`. Provide the implementation with
 * `Effect.provide(AWS.Backup.GetRecoveryPointRestoreMetadataHttp)`.
 * ### Restoring Recovery Points
 * **Example:** Fetch Restore Metadata Then Restore
 * ```typescript
 * const getRestoreMetadata =
 *   yield* AWS.Backup.GetRecoveryPointRestoreMetadata(vault);
 * const startRestoreJob = yield* AWS.Backup.StartRestoreJob(role);
 *
 * const { RestoreMetadata } = yield* getRestoreMetadata({
 *   RecoveryPointArn: recoveryPointArn,
 * });
 * yield* startRestoreJob({
 *   RecoveryPointArn: recoveryPointArn,
 *   Metadata: RestoreMetadata!,
 * });
 * ```
 *
 * @binding
 */
export interface GetRecoveryPointRestoreMetadata extends Binding.Service<
  GetRecoveryPointRestoreMetadata,
  "AWS.Backup.GetRecoveryPointRestoreMetadata",
  (
    vault: BackupVault,
  ) => Effect.Effect<
    (
      request: GetRecoveryPointRestoreMetadataRequest,
    ) => Effect.Effect<
      backup.GetRecoveryPointRestoreMetadataOutput,
      backup.GetRecoveryPointRestoreMetadataError
    >
  >
> {}
export const GetRecoveryPointRestoreMetadata = Binding.Service<GetRecoveryPointRestoreMetadata>(
  "AWS.Backup.GetRecoveryPointRestoreMetadata",
);

export const GetRecoveryPointRestoreMetadataHttp = Layer.effect(
  GetRecoveryPointRestoreMetadata,
  makeBackupVaultHttpBinding({
    tag: "AWS.Backup.GetRecoveryPointRestoreMetadata",
    operation: backup.getRecoveryPointRestoreMetadata,
    actions: ["backup:GetRecoveryPointRestoreMetadata"],
    // Recovery-point actions authorize on the recovery point ARN (the
    // underlying resource's snapshot ARN), not the vault ARN.
    wildcardIam: true,
  }),
);
