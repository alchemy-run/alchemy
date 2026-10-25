import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { ManagedHsmBuiltInRole } from "./ManagedHsmRoleAssignment.ts";
import { UpdateHsmSetting } from "./UpdateHsmSetting.ts";

/**
 * Implementation of {@link UpdateHsmSetting} over the distilled
 * `keyvault-administration` data plane. Grants the host the built-in local role **Managed HSM Administrator** (the settings operations have no documented data action) on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateHsmSetting
 */
export const UpdateHsmSettingHttp = Layer.effect(
  UpdateHsmSetting,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.UpdateHsmSetting",
    operation: admin.UpdateSetting,
    grant: { kind: "UpdateHsmSetting", builtInRole: ManagedHsmBuiltInRole.Administrator },
  }),
);
