import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `PreFullBackup` request without the HSM endpoint, which the bound HSM supplies. */
export interface CheckFullBackupRequest extends Omit<admin.PreFullBackupRequest, "vaultBaseUrl"> {}

/**
 * Check whether a Managed HSM can run a full backup to a container (the pre-backup check), without backing up.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/backup/start/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link CheckFullBackupHttp}.
 *
 * ### Backing Up an HSM
 * **Example:** Check a backup target
 * ```typescript
 * // init
 * const checkBackup = yield* Azure.KeyVault.CheckFullBackup(hsm);
 *
 * // runtime
 * const check = yield* checkBackup({
 *   storageResourceUri: "https://account.blob.core.windows.net/backups",
 *   useManagedIdentity: true,
 * });
 * // …provided with Effect.provide(Azure.KeyVault.CheckFullBackupHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface CheckFullBackup extends Binding.Service<
  CheckFullBackup,
  "Azure.KeyVault.CheckFullBackup",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request?: CheckFullBackupRequest,
    ) => Effect.Effect<admin.PreFullBackupResponse, admin.PreFullBackupError, RuntimeContext>
  >
> {}

export const CheckFullBackup = Binding.Service<CheckFullBackup>("Azure.KeyVault.CheckFullBackup");
