import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { RecoverDeletedCertificate } from "./RecoverDeletedCertificate.ts";

/**
 * Implementation of {@link RecoverDeletedCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/recover/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.RecoverDeletedCertificate
 */
export const RecoverDeletedCertificateHttp = Layer.effect(
  RecoverDeletedCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.RecoverDeletedCertificate",
    operation: certificates.RecoverDeletedCertificate,
    role: CertificateRoles.Recover,
  }),
);
