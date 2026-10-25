import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `RestoreStatus` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetFullRestoreStatusRequest extends Omit<
  admin.RestoreStatusRequest,
  "vaultBaseUrl"
> {}

/**
 * Read the status of a Managed HSM full restore started with {@link StartFullRestore}.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/status/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetFullRestoreStatusHttp}.
 *
 * ### Restoring an HSM
 * **Example:** Poll a restore job
 * ```typescript
 * // init
 * const restoreStatus = yield* Azure.KeyVault.GetFullRestoreStatus(hsm);
 *
 * // runtime
 * const { status } = yield* restoreStatus({ jobId });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetFullRestoreStatus extends Binding.Service<
  GetFullRestoreStatus,
  "Azure.KeyVault.GetFullRestoreStatus",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: GetFullRestoreStatusRequest,
    ) => Effect.Effect<admin.RestoreOperation, admin.RestoreStatusError, RuntimeContext>
  >
> {}

export const GetFullRestoreStatus = Binding.Service<GetFullRestoreStatus>(
  "Azure.KeyVault.GetFullRestoreStatus",
);
