import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { BackupCertificate } from "./BackupCertificate.ts";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";

/**
 * Implementation of {@link BackupCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/backup/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.BackupCertificate
 */
export const BackupCertificateHttp = Layer.effect(
  BackupCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.BackupCertificate",
    operation: certificates.BackupCertificate,
    role: CertificateRoles.Backup,
  }),
);
