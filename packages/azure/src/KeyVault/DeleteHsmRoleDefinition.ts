import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `DeleteRoleDefinition` request without the HSM endpoint, which the bound HSM supplies. */
export interface DeleteHsmRoleDefinitionRequest extends Omit<
  admin.DeleteRoleDefinitionRequest,
  "vaultBaseUrl"
> {}

/**
 * Delete a custom local RBAC role definition of a Managed HSM.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/delete/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link DeleteHsmRoleDefinitionHttp}.
 *
 * ### Managing Roles at Runtime
 * **Example:** Delete a custom role
 * ```typescript
 * // init
 * const deleteRole = yield* Azure.KeyVault.DeleteHsmRoleDefinition(hsm);
 *
 * // runtime
 * yield* deleteRole({ scope: "/", roleDefinitionName: roleGuid });
 * // …provided with Effect.provide(Azure.KeyVault.DeleteHsmRoleDefinitionHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DeleteHsmRoleDefinition extends Binding.Service<
  DeleteHsmRoleDefinition,
  "Azure.KeyVault.DeleteHsmRoleDefinition",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: DeleteHsmRoleDefinitionRequest,
    ) => Effect.Effect<admin.RoleDefinition, admin.DeleteRoleDefinitionError, RuntimeContext>
  >
> {}

export const DeleteHsmRoleDefinition = Binding.Service<DeleteHsmRoleDefinition>(
  "Azure.KeyVault.DeleteHsmRoleDefinition",
);
