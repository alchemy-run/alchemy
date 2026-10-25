import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { DeleteHsmRoleDefinition } from "./DeleteHsmRoleDefinition.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link DeleteHsmRoleDefinition} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/delete/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteHsmRoleDefinition
 */
export const DeleteHsmRoleDefinitionHttp = Layer.effect(
  DeleteHsmRoleDefinition,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.DeleteHsmRoleDefinition",
    operation: admin.DeleteRoleDefinition,
    grant: {
      kind: "DeleteHsmRoleDefinition",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleDefinitions/delete/action"],
    },
  }),
);
