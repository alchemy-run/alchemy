import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { ListHsmSettings } from "./ListHsmSettings.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { ManagedHsmBuiltInRole } from "./ManagedHsmRoleAssignment.ts";

/**
 * Implementation of {@link ListHsmSettings} over the distilled
 * `keyvault-administration` data plane. Grants the host the built-in local role **Managed HSM Administrator** (the settings operations have no documented data action) on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.ListHsmSettings
 */
export const ListHsmSettingsHttp = Layer.effect(
  ListHsmSettings,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.ListHsmSettings",
    operation: admin.GetSettings,
    grant: { kind: "ListHsmSettings", builtInRole: ManagedHsmBuiltInRole.Administrator },
  }),
);
