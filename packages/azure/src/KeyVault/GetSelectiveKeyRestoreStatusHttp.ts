import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Layer from "effect/Layer";
import { GetSelectiveKeyRestoreStatus } from "./GetSelectiveKeyRestoreStatus.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetSelectiveKeyRestoreStatus} over the distilled
 * `keyvault-administration` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/restore/status/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetSelectiveKeyRestoreStatus
 */
export const GetSelectiveKeyRestoreStatusHttp = Layer.effect(
  GetSelectiveKeyRestoreStatus,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetSelectiveKeyRestoreStatus",
    operation: admin.SelectiveKeyRestoreStatus,
    grant: {
      kind: "GetSelectiveKeyRestoreStatus",
      dataActions: ["Microsoft.KeyVault/managedHsm/restore/status/action"],
    },
  }),
);
