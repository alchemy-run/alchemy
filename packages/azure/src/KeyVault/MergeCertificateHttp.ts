import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { MergeCertificate } from "./MergeCertificate.ts";

/**
 * Implementation of {@link MergeCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/create/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.MergeCertificate
 */
export const MergeCertificateHttp = Layer.effect(
  MergeCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.MergeCertificate",
    operation: certificates.MergeCertificate,
    role: CertificateRoles.Create,
  }),
);
