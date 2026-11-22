import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `SelectiveKeyRestoreStatus` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetSelectiveKeyRestoreStatusRequest extends Omit<
  admin.SelectiveKeyRestoreStatusRequest,
  "vaultBaseUrl"
> {}

/**
 * Read the status of a selective key restore started with {@link StartSelectiveKeyRestore}.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/status/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetSelectiveKeyRestoreStatusHttp}.
 *
 * ### Restoring One Key
 * **Example:** Poll a key restore job
 * ```typescript
 * // init
 * const keyRestoreStatus = yield* Azure.KeyVault.GetSelectiveKeyRestoreStatus(hsm);
 *
 * // runtime
 * const { status } = yield* keyRestoreStatus({ jobId });
 * // …provided with Effect.provide(Azure.KeyVault.GetSelectiveKeyRestoreStatusHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetSelectiveKeyRestoreStatus extends Binding.Service<
  GetSelectiveKeyRestoreStatus,
  "Azure.KeyVault.GetSelectiveKeyRestoreStatus",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: GetSelectiveKeyRestoreStatusRequest,
    ) => Effect.Effect<
      admin.SelectiveKeyRestoreOperation2,
      admin.SelectiveKeyRestoreStatusError,
      RuntimeContext
    >
  >
> {}

export const GetSelectiveKeyRestoreStatus = Binding.Service<GetSelectiveKeyRestoreStatus>(
  "Azure.KeyVault.GetSelectiveKeyRestoreStatus",
);
