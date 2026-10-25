import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { GetCertificateContacts } from "./GetCertificateContacts.ts";

/**
 * Implementation of {@link GetCertificateContacts} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecontacts/write` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetCertificateContacts
 */
export const GetCertificateContactsHttp = Layer.effect(
  GetCertificateContacts,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.GetCertificateContacts",
    operation: certificates.GetCertificateContacts,
    role: CertificateRoles.ManageContacts,
  }),
);
