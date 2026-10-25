import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `RoleDefinitionsCreateOrUpdate` request without the HSM endpoint, which the bound HSM supplies. */
export interface PutHsmRoleDefinitionRequest extends Omit<
  admin.RoleDefinitionsCreateOrUpdateRequest,
  "vaultBaseUrl"
> {}

/**
 * Create or update a custom local RBAC role definition in a Managed HSM at runtime.
 *
 * For roles that are part of your infrastructure, use the {@link ManagedHsmRoleDefinition} resource instead.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/write/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link PutHsmRoleDefinitionHttp}.
 *
 * ### Managing Roles at Runtime
 * **Example:** Define a sign-only role
 * ```typescript
 * // init
 * const putRole = yield* Azure.KeyVault.PutHsmRoleDefinition(hsm);
 *
 * // runtime
 * yield* putRole({
 *   scope: "/",
 *   roleDefinitionName: roleGuid,
 *   properties: {
 *     roleName: "Signer",
 *     type: "CustomRole",
 *     permissions: [{ dataActions: ["Microsoft.KeyVault/managedHsm/keys/sign/action"] }],
 *     assignableScopes: ["/"],
 *   },
 * });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface PutHsmRoleDefinition extends Binding.Service<
  PutHsmRoleDefinition,
  "Azure.KeyVault.PutHsmRoleDefinition",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: PutHsmRoleDefinitionRequest,
    ) => Effect.Effect<
      admin.RoleDefinition,
      admin.RoleDefinitionsCreateOrUpdateError,
      RuntimeContext
    >
  >
> {}

export const PutHsmRoleDefinition = Binding.Service<PutHsmRoleDefinition>(
  "Azure.KeyVault.PutHsmRoleDefinition",
);
