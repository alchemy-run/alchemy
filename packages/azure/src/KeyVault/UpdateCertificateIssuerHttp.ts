import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { UpdateCertificateIssuer } from "./UpdateCertificateIssuer.ts";

/**
 * Implementation of {@link UpdateCertificateIssuer} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecas/write` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateCertificateIssuer
 */
export const UpdateCertificateIssuerHttp = Layer.effect(
  UpdateCertificateIssuer,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.UpdateCertificateIssuer",
    operation: certificates.UpdateCertificateIssuer,
    role: CertificateRoles.WriteIssuers,
  }),
);
