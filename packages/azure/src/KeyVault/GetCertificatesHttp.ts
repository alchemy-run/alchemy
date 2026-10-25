import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificates } from "./GetCertificates.ts";

/**
 * Implementation of {@link GetCertificates} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificates
 */
export const GetCertificatesHttp = Layer.effect(
  GetCertificates,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificates",
    operation: certificates.GetCertificates,
    role: CertificateRoles.Read,
  }),
);
