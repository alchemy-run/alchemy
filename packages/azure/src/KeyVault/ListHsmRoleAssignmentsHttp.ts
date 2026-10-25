import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { ListHsmRoleAssignments } from "./ListHsmRoleAssignments.ts";
import { makeManagedHsmListHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link ListHsmRoleAssignments} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/read/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.ListHsmRoleAssignments
 */
export const ListHsmRoleAssignmentsHttp = Layer.effect(
  ListHsmRoleAssignments,
  makeManagedHsmListHttpBinding({
    tag: "Azure.KeyVault.ListHsmRoleAssignments",
    operation: admin.ListRoleAssignmentForScope,
    grant: {
      kind: "ListHsmRoleAssignments",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleAssignments/read/action"],
    },
  }),
);
