import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `FullRestoreOperation` request without the HSM endpoint, which the bound HSM supplies. */
export interface StartFullRestoreRequest extends Omit<
  admin.FullRestoreOperationRequest,
  "vaultBaseUrl"
> {}

/**
 * Restore every key of a Managed HSM from a full backup folder in Azure Blob Storage.
 *
 * The response carries the `jobId` for {@link GetFullRestoreStatus}.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/start/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link StartFullRestoreHttp}.
 *
 * ### Restoring an HSM
 * **Example:** Restore a full backup
 * ```typescript
 * // init
 * const restore = yield* Azure.KeyVault.StartFullRestore(hsm);
 *
 * // runtime
 * const job = yield* restore({
 *   folderToRestore: "mhsm-myhsm-2026102412345678",
 *   sasTokenParameters: {
 *     storageResourceUri: "https://account.blob.core.windows.net/backups",
 *     useManagedIdentity: true,
 *   },
 * });
 * // …provided with Effect.provide(Azure.KeyVault.StartFullRestoreHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface StartFullRestore extends Binding.Service<
  StartFullRestore,
  "Azure.KeyVault.StartFullRestore",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: StartFullRestoreRequest,
    ) => Effect.Effect<
      admin.FullRestoreOperationResponse,
      admin.FullRestoreOperationError,
      RuntimeContext
    >
  >
> {}

export const StartFullRestore = Binding.Service<StartFullRestore>(
  "Azure.KeyVault.StartFullRestore",
);
