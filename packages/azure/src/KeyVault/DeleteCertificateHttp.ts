import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { DeleteCertificate } from "./DeleteCertificate.ts";

/**
 * Implementation of {@link DeleteCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/delete` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteCertificate
 */
export const DeleteCertificateHttp = Layer.effect(
  DeleteCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.DeleteCertificate",
    operation: certificates.DeleteCertificate,
    role: CertificateRoles.Delete,
  }),
);
