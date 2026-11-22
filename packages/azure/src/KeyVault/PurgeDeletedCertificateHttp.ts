import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { PurgeDeletedCertificate } from "./PurgeDeletedCertificate.ts";

/**
 * Implementation of {@link PurgeDeletedCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/purge/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.PurgeDeletedCertificate
 */
export const PurgeDeletedCertificateHttp = Layer.effect(
  PurgeDeletedCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.PurgeDeletedCertificate",
    operation: certificates.PurgeDeletedCertificate,
    role: CertificateRoles.Purge,
  }),
);
