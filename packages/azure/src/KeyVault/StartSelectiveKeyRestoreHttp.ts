import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { StartSelectiveKeyRestore } from "./StartSelectiveKeyRestore.ts";

/**
 * Implementation of {@link StartSelectiveKeyRestore} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/start/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.StartSelectiveKeyRestore
 */
export const StartSelectiveKeyRestoreHttp = Layer.effect(
  StartSelectiveKeyRestore,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.StartSelectiveKeyRestore",
    operation: admin.SelectiveKeyRestoreOperation,
    grant: {
      kind: "StartSelectiveKeyRestore",
      dataActions: ["Microsoft.KeyVault/managedHsm/restore/start/action"],
    },
  }),
);
