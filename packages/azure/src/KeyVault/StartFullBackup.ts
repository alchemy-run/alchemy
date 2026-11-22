import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `FullBackup` request without the HSM endpoint, which the bound HSM supplies. */
export interface StartFullBackupRequest extends Omit<admin.FullBackupRequest, "vaultBaseUrl"> {}

/**
 * Start a full backup of a Managed HSM (keys, versions, attributes, tags and role assignments) to an Azure Blob Storage container.
 *
 * Pass a container SAS `token`, or `useManagedIdentity: true` when the HSM has a user-assigned identity with Storage Blob Data Contributor on the container. The response carries the `jobId` for {@link GetFullBackupStatus}.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/backup/start/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link StartFullBackupHttp}.
 *
 * ### Backing Up an HSM
 * **Example:** Start a full backup
 * ```typescript
 * // init
 * const backup = yield* Azure.KeyVault.StartFullBackup(hsm);
 *
 * // runtime
 * const job = yield* backup({
 *   storageResourceUri: "https://account.blob.core.windows.net/backups",
 *   useManagedIdentity: true,
 * });
 * // …provided with Effect.provide(Azure.KeyVault.StartFullBackupHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface StartFullBackup extends Binding.Service<
  StartFullBackup,
  "Azure.KeyVault.StartFullBackup",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: StartFullBackupRequest,
    ) => Effect.Effect<admin.FullBackupResponse, admin.FullBackupError, RuntimeContext>
  >
> {}

export const StartFullBackup = Binding.Service<StartFullBackup>("Azure.KeyVault.StartFullBackup");
