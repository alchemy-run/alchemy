import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { ImportCertificate } from "./ImportCertificate.ts";

/**
 * Implementation of {@link ImportCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/import/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.ImportCertificate
 */
export const ImportCertificateHttp = Layer.effect(
  ImportCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.ImportCertificate",
    operation: certificates.ImportCertificate,
    role: CertificateRoles.Import,
  }),
);
