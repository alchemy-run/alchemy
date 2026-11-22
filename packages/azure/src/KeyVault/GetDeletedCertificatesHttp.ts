import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetDeletedCertificates } from "./GetDeletedCertificates.ts";

/**
 * Implementation of {@link GetDeletedCertificates} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetDeletedCertificates
 */
export const GetDeletedCertificatesHttp = Layer.effect(
  GetDeletedCertificates,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetDeletedCertificates",
    operation: certificates.GetDeletedCertificates,
    role: CertificateRoles.Read,
  }),
);
