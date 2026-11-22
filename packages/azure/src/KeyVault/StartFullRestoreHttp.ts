import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { StartFullRestore } from "./StartFullRestore.ts";

/**
 * Implementation of {@link StartFullRestore} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/start/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.StartFullRestore
 */
export const StartFullRestoreHttp = Layer.effect(
  StartFullRestore,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.StartFullRestore",
    operation: admin.FullRestoreOperation,
    grant: {
      kind: "StartFullRestore",
      dataActions: ["Microsoft.KeyVault/managedHsm/restore/start/action"],
    },
  }),
);
