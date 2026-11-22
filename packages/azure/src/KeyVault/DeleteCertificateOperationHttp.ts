import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { DeleteCertificateOperation } from "./DeleteCertificateOperation.ts";

/**
 * Implementation of {@link DeleteCertificateOperation} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/update/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteCertificateOperation
 */
export const DeleteCertificateOperationHttp = Layer.effect(
  DeleteCertificateOperation,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.DeleteCertificateOperation",
    operation: certificates.DeleteCertificateOperation,
    role: CertificateRoles.Update,
  }),
);
