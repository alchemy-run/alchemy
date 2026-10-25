import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { GetHsmSetting } from "./GetHsmSetting.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { ManagedHsmBuiltInRole } from "./ManagedHsmRoleAssignment.ts";

/**
 * Implementation of {@link GetHsmSetting} over the distilled
 * `keyvault-administration` data plane. Grants the host the built-in local role **Managed HSM Administrator** (the settings operations have no documented data action) on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetHsmSetting
 */
export const GetHsmSettingHttp = Layer.effect(
  GetHsmSetting,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetHsmSetting",
    operation: admin.GetSetting,
    grant: { kind: "GetHsmSetting", builtInRole: ManagedHsmBuiltInRole.Administrator },
  }),
);
