import * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Layer from "effect/Layer";
import { DownloadSecurityDomain } from "./DownloadSecurityDomain.ts";
import { makeManagedHsmHttpBinding } from "./ManagedHsmBindingHttp.ts";

/**
 * Implementation of {@link DownloadSecurityDomain} over the distilled
 * `keyvault-security-domain` data plane. Grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/download/action` on the HSM.
 *
 * @layer
 * @provides Azure.KeyVault.DownloadSecurityDomain
 */
export const DownloadSecurityDomainHttp = Layer.effect(
  DownloadSecurityDomain,
  makeManagedHsmHttpBinding({
    tag: "Azure.KeyVault.DownloadSecurityDomain",
    operation: securityDomain.DownloadHSMSecurityDomain,
    grant: {
      kind: "DownloadSecurityDomain",
      dataActions: ["Microsoft.KeyVault/managedHsm/securitydomain/download/action"],
    },
  }),
);
