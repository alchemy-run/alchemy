import * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Layer from "effect/Layer";
import { GetSecurityDomainTransferKey } from "./GetSecurityDomainTransferKey.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetSecurityDomainTransferKey} over the distilled
 * `keyvault-security-domain` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/transferkey/read` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetSecurityDomainTransferKey
 */
export const GetSecurityDomainTransferKeyHttp = Layer.effect(
  GetSecurityDomainTransferKey,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetSecurityDomainTransferKey",
    operation: securityDomain.TransferHSMSecurityDomainKey,
    grant: {
      kind: "GetSecurityDomainTransferKey",
      dataActions: ["Microsoft.KeyVault/managedHsm/securitydomain/transferkey/read"],
    },
  }),
);
