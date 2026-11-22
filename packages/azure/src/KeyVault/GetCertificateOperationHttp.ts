import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificateOperation } from "./GetCertificateOperation.ts";

/**
 * Implementation of {@link GetCertificateOperation} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificateOperation
 */
export const GetCertificateOperationHttp = Layer.effect(
  GetCertificateOperation,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificateOperation",
    operation: certificates.GetCertificateOperation,
    role: CertificateRoles.Read,
  }),
);
