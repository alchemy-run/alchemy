import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetDeletedCertificate } from "./GetDeletedCertificate.ts";

/**
 * Implementation of {@link GetDeletedCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetDeletedCertificate
 */
export const GetDeletedCertificateHttp = Layer.effect(
  GetDeletedCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetDeletedCertificate",
    operation: certificates.GetDeletedCertificate,
    role: CertificateRoles.Read,
  }),
);
