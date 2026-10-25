import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `ListRoleAssignmentForScope` request without the HSM endpoint, which the bound HSM supplies. */
export interface ListHsmRoleAssignmentsRequest extends Omit<
  admin.ListRoleAssignmentForScopeRequest,
  "vaultBaseUrl" | "nextLink"
> {}

/**
 * List the local RBAC role assignments of a Managed HSM at a scope (`/`, `/keys` or `/keys/{name}`), across every page.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/read/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link ListHsmRoleAssignmentsHttp}.
 *
 * ### Reading Role Assignments
 * **Example:** List assignments for one principal
 * ```typescript
 * // init
 * const listAssignments = yield* Azure.KeyVault.ListHsmRoleAssignments(hsm);
 *
 * // runtime
 * const assignments = yield* listAssignments({
 *   scope: "/",
 *   _filter: `principalId eq '${principalId}'`,
 * });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface ListHsmRoleAssignments extends Binding.Service<
  ListHsmRoleAssignments,
  "Azure.KeyVault.ListHsmRoleAssignments",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: ListHsmRoleAssignmentsRequest,
    ) => Effect.Effect<
      admin.RoleAssignment[],
      admin.ListRoleAssignmentForScopeError,
      RuntimeContext
    >
  >
> {}

export const ListHsmRoleAssignments = Binding.Service<ListHsmRoleAssignments>(
  "Azure.KeyVault.ListHsmRoleAssignments",
);
