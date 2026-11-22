import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { UpdateCertificate } from "./UpdateCertificate.ts";

/**
 * Implementation of {@link UpdateCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/update/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateCertificate
 */
export const UpdateCertificateHttp = Layer.effect(
  UpdateCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.UpdateCertificate",
    operation: certificates.UpdateCertificate,
    role: CertificateRoles.Update,
  }),
);
