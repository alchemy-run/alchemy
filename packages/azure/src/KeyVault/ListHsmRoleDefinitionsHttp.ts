import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { ListHsmRoleDefinitions } from "./ListHsmRoleDefinitions.ts";
import { makeManagedHsmListHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link ListHsmRoleDefinitions} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleDefinitions/read/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.ListHsmRoleDefinitions
 */
export const ListHsmRoleDefinitionsHttp = Layer.effect(
  ListHsmRoleDefinitions,
  makeManagedHsmListHttpBinding({
    tag: "Azure.KeyVault.ListHsmRoleDefinitions",
    operation: admin.ListRoleDefinitions,
    grant: {
      kind: "ListHsmRoleDefinitions",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleDefinitions/read/action"],
    },
  }),
);
