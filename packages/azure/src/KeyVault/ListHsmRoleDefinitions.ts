import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `ListRoleDefinitions` request without the HSM endpoint, which the bound HSM supplies. */
export interface ListHsmRoleDefinitionsRequest extends Omit<
  admin.ListRoleDefinitionsRequest,
  "vaultBaseUrl" | "nextLink"
> {}

/**
 * List the local RBAC role definitions (built-in and custom) of a Managed HSM, across every page.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/read/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link ListHsmRoleDefinitionsHttp}.
 *
 * ### Reading Role Definitions
 * **Example:** List every role
 * ```typescript
 * // init
 * const listRoles = yield* Azure.KeyVault.ListHsmRoleDefinitions(hsm);
 *
 * // runtime
 * const roles = yield* listRoles({ scope: "/" });
 * // …provided with Effect.provide(Azure.KeyVault.ListHsmRoleDefinitionsHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface ListHsmRoleDefinitions extends Binding.Service<
  ListHsmRoleDefinitions,
  "Azure.KeyVault.ListHsmRoleDefinitions",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: ListHsmRoleDefinitionsRequest,
    ) => Effect.Effect<admin.RoleDefinition[], admin.ListRoleDefinitionsError, RuntimeContext>
  >
> {}

export const ListHsmRoleDefinitions = Binding.Service<ListHsmRoleDefinitions>(
  "Azure.KeyVault.ListHsmRoleDefinitions",
);
