import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { RestoreCertificate } from "./RestoreCertificate.ts";

/**
 * Implementation of {@link RestoreCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/restore/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.RestoreCertificate
 */
export const RestoreCertificateHttp = Layer.effect(
  RestoreCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.RestoreCertificate",
    operation: certificates.RestoreCertificate,
    role: CertificateRoles.Restore,
  }),
);
