import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { GetFullBackupStatus } from "./GetFullBackupStatus.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetFullBackupStatus} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/backup/status/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetFullBackupStatus
 */
export const GetFullBackupStatusHttp = Layer.effect(
  GetFullBackupStatus,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetFullBackupStatus",
    operation: admin.FullBackupStatus,
    grant: {
      kind: "GetFullBackupStatus",
      dataActions: ["Microsoft.KeyVault/managedHsm/backup/status/action"],
    },
  }),
);
