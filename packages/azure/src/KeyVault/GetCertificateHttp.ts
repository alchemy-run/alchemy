import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificate } from "./GetCertificate.ts";

/**
 * Implementation of {@link GetCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificate
 */
export const GetCertificateHttp = Layer.effect(
  GetCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificate",
    operation: certificates.GetCertificate,
    role: CertificateRoles.Read,
  }),
);
