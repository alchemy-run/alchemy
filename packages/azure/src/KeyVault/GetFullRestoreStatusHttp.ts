import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { GetFullRestoreStatus } from "./GetFullRestoreStatus.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetFullRestoreStatus} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/status/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetFullRestoreStatus
 */
export const GetFullRestoreStatusHttp = Layer.effect(
  GetFullRestoreStatus,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetFullRestoreStatus",
    operation: admin.RestoreStatus,
    grant: {
      kind: "GetFullRestoreStatus",
      dataActions: ["Microsoft.KeyVault/managedHsm/restore/status/action"],
    },
  }),
);
