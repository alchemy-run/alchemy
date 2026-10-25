import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { UpdateCertificateOperation } from "./UpdateCertificateOperation.ts";

/**
 * Implementation of {@link UpdateCertificateOperation} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/update/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateCertificateOperation
 */
export const UpdateCertificateOperationHttp = Layer.effect(
  UpdateCertificateOperation,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.UpdateCertificateOperation",
    operation: certificates.UpdateCertificateOperation,
    role: CertificateRoles.Update,
  }),
);
