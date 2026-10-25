import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { CreateCertificate } from "./CreateCertificate.ts";

/**
 * Implementation of {@link CreateCertificate} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/create/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.CreateCertificate
 */
export const CreateCertificateHttp = Layer.effect(
  CreateCertificate,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.CreateCertificate",
    operation: certificates.CreateCertificate,
    role: CertificateRoles.Create,
  }),
);
