import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificatePolicy } from "./GetCertificatePolicy.ts";

/**
 * Implementation of {@link GetCertificatePolicy} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificatePolicy
 */
export const GetCertificatePolicyHttp = Layer.effect(
  GetCertificatePolicy,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificatePolicy",
    operation: certificates.GetCertificatePolicy,
    role: CertificateRoles.Read,
  }),
);
