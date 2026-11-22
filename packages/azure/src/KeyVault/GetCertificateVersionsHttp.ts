import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificateVersions } from "./GetCertificateVersions.ts";

/**
 * Implementation of {@link GetCertificateVersions} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificateVersions
 */
export const GetCertificateVersionsHttp = Layer.effect(
  GetCertificateVersions,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificateVersions",
    operation: certificates.GetCertificateVersions,
    role: CertificateRoles.Read,
  }),
);
