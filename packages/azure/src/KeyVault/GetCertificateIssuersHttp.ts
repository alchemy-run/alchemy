import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificateIssuers } from "./GetCertificateIssuers.ts";

/**
 * Implementation of {@link GetCertificateIssuers} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecas/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificateIssuers
 */
export const GetCertificateIssuersHttp = Layer.effect(
  GetCertificateIssuers,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificateIssuers",
    operation: certificates.GetCertificateIssuers,
    role: CertificateRoles.ReadIssuers,
  }),
);
