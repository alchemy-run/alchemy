import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Layer from "effect/Layer";
import { CertificateRoles, makeVaultCertificateBinding } from "./CertificateBindingHttp.ts";
import { SetCertificateContacts } from "./SetCertificateContacts.ts";

/**
 * Implementation of {@link SetCertificateContacts} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecontacts/write` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.SetCertificateContacts
 */
export const SetCertificateContactsHttp = Layer.effect(
  SetCertificateContacts,
  makeVaultCertificateBinding({
    tag: "Azure.KeyVault.SetCertificateContacts",
    operation: certificates.SetCertificateContacts,
    role: CertificateRoles.ManageContacts,
  }),
);
