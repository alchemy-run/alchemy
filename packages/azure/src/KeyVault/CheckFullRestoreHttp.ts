import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { CheckFullRestore } from "./CheckFullRestore.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link CheckFullRestore} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/start/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.CheckFullRestore
 */
export const CheckFullRestoreHttp = Layer.effect(
  CheckFullRestore,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.CheckFullRestore",
    operation: admin.PreFullRestoreOperation,
    grant: {
      kind: "CheckFullRestore",
      dataActions: ["Microsoft.KeyVault/managedHsm/restore/start/action"],
    },
  }),
);
