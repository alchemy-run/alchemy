import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { DeleteCertificateIssuer } from "./DeleteCertificateIssuer.ts";

/**
 * Implementation of {@link DeleteCertificateIssuer} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecas/delete` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteCertificateIssuer
 */
export const DeleteCertificateIssuerHttp = Layer.effect(
  DeleteCertificateIssuer,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.DeleteCertificateIssuer",
    operation: certificates.DeleteCertificateIssuer,
    role: CertificateRoles.DeleteIssuers,
  }),
);
