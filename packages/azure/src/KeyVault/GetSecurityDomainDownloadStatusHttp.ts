import * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Layer from "effect/Layer";
import { GetSecurityDomainDownloadStatus } from "./GetSecurityDomainDownloadStatus.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetSecurityDomainDownloadStatus} over the distilled
 * `keyvault-security-domain` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/download/read` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetSecurityDomainDownloadStatus
 */
export const GetSecurityDomainDownloadStatusHttp = Layer.effect(
  GetSecurityDomainDownloadStatus,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetSecurityDomainDownloadStatus",
    operation: securityDomain.DownloadHSMSecurityDomainPending,
    grant: {
      kind: "GetSecurityDomainDownloadStatus",
      dataActions: ["Microsoft.KeyVault/managedHsm/securitydomain/download/read"],
    },
  }),
);
