import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { DeleteHsmRoleAssignment } from "./DeleteHsmRoleAssignment.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link DeleteHsmRoleAssignment} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/delete/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteHsmRoleAssignment
 */
export const DeleteHsmRoleAssignmentHttp = Layer.effect(
  DeleteHsmRoleAssignment,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.DeleteHsmRoleAssignment",
    operation: admin.DeleteRoleAssignment,
    grant: {
      kind: "DeleteHsmRoleAssignment",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleAssignments/delete/action"],
    },
  }),
);
