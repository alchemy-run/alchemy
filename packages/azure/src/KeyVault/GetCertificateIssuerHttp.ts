import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificateIssuer } from "./GetCertificateIssuer.ts";

/**
 * Implementation of {@link GetCertificateIssuer} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecas/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificateIssuer
 */
export const GetCertificateIssuerHttp = Layer.effect(
  GetCertificateIssuer,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificateIssuer",
    operation: certificates.GetCertificateIssuer,
    role: CertificateRoles.ReadIssuers,
  }),
);
