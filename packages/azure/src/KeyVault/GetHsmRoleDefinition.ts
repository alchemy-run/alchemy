import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `GetRoleDefinition` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetHsmRoleDefinitionRequest extends Omit<
  admin.GetRoleDefinitionRequest,
  "vaultBaseUrl"
> {}

/**
 * Read one local RBAC role definition of a Managed HSM.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/read/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetHsmRoleDefinitionHttp}.
 *
 * ### Reading Role Definitions
 * **Example:** Read the Crypto User role
 * ```typescript
 * // init
 * const getRole = yield* Azure.KeyVault.GetHsmRoleDefinition(hsm);
 *
 * // runtime
 * const role = yield* getRole({
 *   scope: "/",
 *   roleDefinitionName: "21dbd100-6940-42c2-9190-5d6cb909625b",
 * });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetHsmRoleDefinition extends Binding.Service<
  GetHsmRoleDefinition,
  "Azure.KeyVault.GetHsmRoleDefinition",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: GetHsmRoleDefinitionRequest,
    ) => Effect.Effect<admin.RoleDefinition, admin.GetRoleDefinitionError, RuntimeContext>
  >
> {}

export const GetHsmRoleDefinition = Binding.Service<GetHsmRoleDefinition>(
  "Azure.KeyVault.GetHsmRoleDefinition",
);
