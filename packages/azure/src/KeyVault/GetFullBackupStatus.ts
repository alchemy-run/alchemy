import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `FullBackupStatus` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetFullBackupStatusRequest extends Omit<
  admin.FullBackupStatusRequest,
  "vaultBaseUrl"
> {}

/**
 * Read the status of a Managed HSM full backup started with {@link StartFullBackup}.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/backup/status/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetFullBackupStatusHttp}.
 *
 * ### Backing Up an HSM
 * **Example:** Poll a backup job
 * ```typescript
 * // init
 * const backupStatus = yield* Azure.KeyVault.GetFullBackupStatus(hsm);
 *
 * // runtime
 * const { status, azureStorageBlobContainerUri } = yield* backupStatus({ jobId });
 * // …provided with Effect.provide(Azure.KeyVault.GetFullBackupStatusHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetFullBackupStatus extends Binding.Service<
  GetFullBackupStatus,
  "Azure.KeyVault.GetFullBackupStatus",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: GetFullBackupStatusRequest,
    ) => Effect.Effect<admin.FullBackupOperation, admin.FullBackupStatusError, RuntimeContext>
  >
> {}

export const GetFullBackupStatus = Binding.Service<GetFullBackupStatus>(
  "Azure.KeyVault.GetFullBackupStatus",
);
