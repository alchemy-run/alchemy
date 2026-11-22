import * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Layer from "effect/Layer";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";
import { UploadSecurityDomain } from "./UploadSecurityDomain.ts";

/**
 * Implementation of {@link UploadSecurityDomain} over the distilled
 * `keyvault-security-domain` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/upload/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.UploadSecurityDomain
 */
export const UploadSecurityDomainHttp = Layer.effect(
  UploadSecurityDomain,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.UploadSecurityDomain",
    operation: securityDomain.UploadHSMSecurityDomain,
    grant: {
      kind: "UploadSecurityDomain",
      dataActions: ["Microsoft.KeyVault/managedHsm/securitydomain/upload/action"],
    },
  }),
);
