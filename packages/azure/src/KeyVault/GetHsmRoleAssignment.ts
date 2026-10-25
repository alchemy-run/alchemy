import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `GetRoleAssignment` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetHsmRoleAssignmentRequest extends Omit<
  admin.GetRoleAssignmentRequest,
  "vaultBaseUrl"
> {}

/**
 * Read one local RBAC role assignment of a Managed HSM.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/read/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetHsmRoleAssignmentHttp}.
 *
 * ### Reading Role Assignments
 * **Example:** Read an assignment
 * ```typescript
 * // init
 * const getAssignment = yield* Azure.KeyVault.GetHsmRoleAssignment(hsm);
 *
 * // runtime
 * const assignment = yield* getAssignment({ scope: "/", roleAssignmentName });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetHsmRoleAssignment extends Binding.Service<
  GetHsmRoleAssignment,
  "Azure.KeyVault.GetHsmRoleAssignment",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: GetHsmRoleAssignmentRequest,
    ) => Effect.Effect<admin.RoleAssignment, admin.GetRoleAssignmentError, RuntimeContext>
  >
> {}

export const GetHsmRoleAssignment = Binding.Service<GetHsmRoleAssignment>(
  "Azure.KeyVault.GetHsmRoleAssignment",
);
