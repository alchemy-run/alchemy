import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `PreFullRestoreOperation` request without the HSM endpoint, which the bound HSM supplies. */
export interface CheckFullRestoreRequest extends Omit<
  admin.PreFullRestoreOperationRequest,
  "vaultBaseUrl"
> {}

/**
 * Check whether a Managed HSM can be restored from a backup folder (the pre-restore check), without restoring.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/start/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link CheckFullRestoreHttp}.
 *
 * ### Restoring an HSM
 * **Example:** Check a backup folder
 * ```typescript
 * // init
 * const checkRestore = yield* Azure.KeyVault.CheckFullRestore(hsm);
 *
 * // runtime
 * const check = yield* checkRestore({
 *   folderToRestore: "mhsm-myhsm-2026102412345678",
 *   sasTokenParameters: {
 *     storageResourceUri: "https://account.blob.core.windows.net/backups",
 *     useManagedIdentity: true,
 *   },
 * });
 * // …provided with Effect.provide(Azure.KeyVault.CheckFullRestoreHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface CheckFullRestore extends Binding.Service<
  CheckFullRestore,
  "Azure.KeyVault.CheckFullRestore",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request?: CheckFullRestoreRequest,
    ) => Effect.Effect<
      admin.PreFullRestoreOperationResponse,
      admin.PreFullRestoreOperationError,
      RuntimeContext
    >
  >
> {}

export const CheckFullRestore = Binding.Service<CheckFullRestore>(
  "Azure.KeyVault.CheckFullRestore",
);
