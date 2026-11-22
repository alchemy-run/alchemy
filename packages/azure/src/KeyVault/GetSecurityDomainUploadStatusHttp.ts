import * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Layer from "effect/Layer";
import { GetSecurityDomainUploadStatus } from "./GetSecurityDomainUploadStatus.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link GetSecurityDomainUploadStatus} over the distilled
 * `keyvault-security-domain` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/upload/read` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.GetSecurityDomainUploadStatus
 */
export const GetSecurityDomainUploadStatusHttp = Layer.effect(
  GetSecurityDomainUploadStatus,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.GetSecurityDomainUploadStatus",
    operation: securityDomain.UploadHSMSecurityDomainPending,
    grant: {
      kind: "GetSecurityDomainUploadStatus",
      dataActions: ["Microsoft.KeyVault/managedHsm/securitydomain/upload/read"],
    },
  }),
);
