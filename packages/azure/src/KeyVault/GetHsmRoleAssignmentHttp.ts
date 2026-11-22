import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { GetHsmRoleAssignment } from "./GetHsmRoleAssignment.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetHsmRoleAssignment} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/read/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetHsmRoleAssignment
 */
export const GetHsmRoleAssignmentHttp = Layer.effect(
  GetHsmRoleAssignment,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetHsmRoleAssignment",
    operation: admin.GetRoleAssignment,
    grant: {
      kind: "GetHsmRoleAssignment",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleAssignments/read/action"],
    },
  }),
);
