import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { GetHsmRoleDefinition } from "./GetHsmRoleDefinition.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetHsmRoleDefinition} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/read/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetHsmRoleDefinition
 */
export const GetHsmRoleDefinitionHttp = Layer.effect(
  GetHsmRoleDefinition,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetHsmRoleDefinition",
    operation: admin.GetRoleDefinition,
    grant: {
      kind: "GetHsmRoleDefinition",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleDefinitions/read/action"],
    },
  }),
);
