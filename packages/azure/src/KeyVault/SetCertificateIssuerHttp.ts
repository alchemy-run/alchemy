import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { SetCertificateIssuer } from "./SetCertificateIssuer.ts";

/**
 * Implementation of {@link SetCertificateIssuer} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecas/write` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.SetCertificateIssuer
 */
export const SetCertificateIssuerHttp = Layer.effect(
  SetCertificateIssuer,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.SetCertificateIssuer",
    operation: certificates.SetCertificateIssuer,
    role: CertificateRoles.WriteIssuers,
  }),
);
