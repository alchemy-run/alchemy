import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { PutHsmRoleDefinition } from "./PutHsmRoleDefinition.ts";

/**
 * Implementation of {@link PutHsmRoleDefinition} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/write/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.PutHsmRoleDefinition
 */
export const PutHsmRoleDefinitionHttp = Layer.effect(
  PutHsmRoleDefinition,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.PutHsmRoleDefinition",
    operation: admin.RoleDefinitionsCreateOrUpdate,
    grant: {
      kind: "PutHsmRoleDefinition",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleDefinitions/write/action"],
    },
  }),
);
