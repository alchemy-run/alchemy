import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { UpdateCertificatePolicy } from "./UpdateCertificatePolicy.ts";

/**
 * Implementation of {@link UpdateCertificatePolicy} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/update/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateCertificatePolicy
 */
export const UpdateCertificatePolicyHttp = Layer.effect(
  UpdateCertificatePolicy,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.UpdateCertificatePolicy",
    operation: certificates.UpdateCertificatePolicy,
    role: CertificateRoles.Update,
  }),
);
