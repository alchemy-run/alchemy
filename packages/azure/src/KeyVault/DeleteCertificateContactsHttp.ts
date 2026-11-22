import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { DeleteCertificateContacts } from "./DeleteCertificateContacts.ts";

/**
 * Implementation of {@link DeleteCertificateContacts} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecontacts/write` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteCertificateContacts
 */
export const DeleteCertificateContactsHttp = Layer.effect(
  DeleteCertificateContacts,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.DeleteCertificateContacts",
    operation: certificates.DeleteCertificateContacts,
    role: CertificateRoles.ManageContacts,
  }),
);
