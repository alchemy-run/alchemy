import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `DeleteRoleAssignment` request without the HSM endpoint, which the bound HSM supplies. */
export interface DeleteHsmRoleAssignmentRequest extends Omit<
  admin.DeleteRoleAssignmentRequest,
  "vaultBaseUrl"
> {}

/**
 * Delete a local RBAC role assignment of a Managed HSM.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/delete/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link DeleteHsmRoleAssignmentHttp}.
 *
 * ### Granting Roles at Runtime
 * **Example:** Revoke an assignment
 * ```typescript
 * // init
 * const revoke = yield* Azure.KeyVault.DeleteHsmRoleAssignment(hsm);
 *
 * // runtime
 * yield* revoke({ scope: "/keys/tenant-a", roleAssignmentName });
 * // …provided with Effect.provide(Azure.KeyVault.DeleteHsmRoleAssignmentHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DeleteHsmRoleAssignment extends Binding.Service<
  DeleteHsmRoleAssignment,
  "Azure.KeyVault.DeleteHsmRoleAssignment",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: DeleteHsmRoleAssignmentRequest,
    ) => Effect.Effect<admin.RoleAssignment, admin.DeleteRoleAssignmentError, RuntimeContext>
  >
> {}

export const DeleteHsmRoleAssignment = Binding.Service<DeleteHsmRoleAssignment>(
  "Azure.KeyVault.DeleteHsmRoleAssignment",
);
