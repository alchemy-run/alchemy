import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `CreateRoleAssignment` request without the HSM endpoint, which the bound HSM supplies. */
export interface CreateHsmRoleAssignmentRequest extends Omit<
  admin.CreateRoleAssignmentRequest,
  "vaultBaseUrl"
> {}

/**
 * Create a local RBAC role assignment in a Managed HSM at runtime (e.g. to grant a tenant's identity a key).
 *
 * For assignments that are part of your infrastructure, use the {@link ManagedHsmRoleAssignment} resource instead. A host that can create assignments can grant itself any HSM role.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/write/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link CreateHsmRoleAssignmentHttp}.
 *
 * ### Granting Roles at Runtime
 * **Example:** Grant Crypto User on one key
 * ```typescript
 * // init
 * const assign = yield* Azure.KeyVault.CreateHsmRoleAssignment(hsm);
 *
 * // runtime
 * yield* assign({
 *   scope: "/keys/tenant-a",
 *   roleAssignmentName: crypto.randomUUID(),
 *   properties: {
 *     roleDefinitionId:
 *       "Microsoft.KeyVault/providers/Microsoft.Authorization/roleDefinitions/21dbd100-6940-42c2-9190-5d6cb909625b",
 *     principalId: tenantPrincipalId,
 *   },
 * });
 * // …provided with Effect.provide(Azure.KeyVault.CreateHsmRoleAssignmentHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface CreateHsmRoleAssignment extends Binding.Service<
  CreateHsmRoleAssignment,
  "Azure.KeyVault.CreateHsmRoleAssignment",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: CreateHsmRoleAssignmentRequest,
    ) => Effect.Effect<admin.RoleAssignment, admin.CreateRoleAssignmentError, RuntimeContext>
  >
> {}

export const CreateHsmRoleAssignment = Binding.Service<CreateHsmRoleAssignment>(
  "Azure.KeyVault.CreateHsmRoleAssignment",
);
