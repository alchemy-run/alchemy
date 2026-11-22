import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { StartFullBackup } from "./StartFullBackup.ts";

/**
 * Implementation of {@link StartFullBackup} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/backup/start/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.StartFullBackup
 */
export const StartFullBackupHttp = Layer.effect(
  StartFullBackup,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.StartFullBackup",
    operation: admin.FullBackup,
    grant: {
      kind: "StartFullBackup",
      dataActions: ["Microsoft.KeyVault/managedHsm/backup/start/action"],
    },
  }),
);
