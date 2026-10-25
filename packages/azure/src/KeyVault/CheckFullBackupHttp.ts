import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { CheckFullBackup } from "./CheckFullBackup.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link CheckFullBackup} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/backup/start/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.CheckFullBackup
 */
export const CheckFullBackupHttp = Layer.effect(
  CheckFullBackup,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.CheckFullBackup",
    operation: admin.PreFullBackup,
    grant: {
      kind: "CheckFullBackup",
      dataActions: ["Microsoft.KeyVault/managedHsm/backup/start/action"],
    },
  }),
);
