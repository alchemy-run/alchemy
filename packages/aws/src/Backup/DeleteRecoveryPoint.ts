import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { BackupVault } from "./BackupVault.ts";
import { makeBackupVaultHttpBinding } from "./BindingHttp.ts";

/**
 * `DeleteRecoveryPoint` request with `BackupVaultName` injected from the
 * bound {@link BackupVault}.
 */
export interface DeleteRecoveryPointRequest extends Omit<
  backup.DeleteRecoveryPointInput,
  "BackupVaultName"
> {}

/**
 * Runtime binding for the `DeleteRecoveryPoint` operation (IAM action
 * `backup:DeleteRecoveryPoint`).
 *
 * Deletes a recovery point from the bound {@link BackupVault} — e.g. a
 * retention janitor pruning on-demand backups. Provide the implementation
 * with `Effect.provide(AWS.Backup.DeleteRecoveryPointHttp)`.
 * ### Recovery Points
 * **Example:** Prune A Recovery Point
 * ```typescript
 * const deleteRecoveryPoint = yield* AWS.Backup.DeleteRecoveryPoint(vault);
 *
 * yield* deleteRecoveryPoint({ RecoveryPointArn: recoveryPointArn });
 * ```
 *
 * @binding
 */
export interface DeleteRecoveryPoint extends Binding.Service<
  DeleteRecoveryPoint,
  "AWS.Backup.DeleteRecoveryPoint",
  (
    vault: BackupVault,
  ) => Effect.Effect<
    (
      request: DeleteRecoveryPointRequest,
    ) => Effect.Effect<backup.DeleteRecoveryPointResponse, backup.DeleteRecoveryPointError>
  >
> {}
export const DeleteRecoveryPoint = Binding.Service<DeleteRecoveryPoint>(
  "AWS.Backup.DeleteRecoveryPoint",
);

export const DeleteRecoveryPointHttp = Layer.effect(
  DeleteRecoveryPoint,
  makeBackupVaultHttpBinding({
    tag: "AWS.Backup.DeleteRecoveryPoint",
    operation: backup.deleteRecoveryPoint,
    actions: ["backup:DeleteRecoveryPoint"],
    // Recovery-point actions authorize on the recovery point ARN (the
    // underlying resource's snapshot ARN), not the vault ARN.
    wildcardIam: true,
  }),
);
