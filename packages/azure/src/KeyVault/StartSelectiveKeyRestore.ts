import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `SelectiveKeyRestoreOperation` request without the HSM endpoint, which the bound HSM supplies. */
export interface StartSelectiveKeyRestoreRequest extends Omit<
  admin.SelectiveKeyRestoreOperationRequest,
  "vaultBaseUrl"
> {}

/**
 * Restore every version of one key of a Managed HSM from a full backup folder in Azure Blob Storage.
 *
 * The response carries the `jobId` for {@link GetSelectiveKeyRestoreStatus}.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/start/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link StartSelectiveKeyRestoreHttp}.
 *
 * ### Restoring One Key
 * **Example:** Restore one key
 * ```typescript
 * // init
 * const restoreKey = yield* Azure.KeyVault.StartSelectiveKeyRestore(hsm);
 *
 * // runtime
 * const job = yield* restoreKey({
 *   keyName: "payments",
 *   folder: "mhsm-myhsm-2026102412345678",
 *   sasTokenParameters: {
 *     storageResourceUri: "https://account.blob.core.windows.net/backups",
 *     useManagedIdentity: true,
 *   },
 * });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface StartSelectiveKeyRestore extends Binding.Service<
  StartSelectiveKeyRestore,
  "Azure.KeyVault.StartSelectiveKeyRestore",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: StartSelectiveKeyRestoreRequest,
    ) => Effect.Effect<
      admin.SelectiveKeyRestoreOperationResponse,
      admin.SelectiveKeyRestoreOperationError,
      RuntimeContext
    >
  >
> {}

export const StartSelectiveKeyRestore = Binding.Service<StartSelectiveKeyRestore>(
  "Azure.KeyVault.StartSelectiveKeyRestore",
);
