import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { CreateHsmRoleAssignment } from "./CreateHsmRoleAssignment.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link CreateHsmRoleAssignment} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/roleAssignments/write/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.CreateHsmRoleAssignment
 */
export const CreateHsmRoleAssignmentHttp = Layer.effect(
  CreateHsmRoleAssignment,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.CreateHsmRoleAssignment",
    operation: admin.CreateRoleAssignment,
    grant: {
      kind: "CreateHsmRoleAssignment",
      dataActions: ["Microsoft.KeyVault/managedHsm/roleAssignments/write/action"],
    },
  }),
);
