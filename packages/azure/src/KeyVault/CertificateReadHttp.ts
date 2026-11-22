import * as Layer from "effect/Layer";
import {
  makeCertificateLevelBinding,
  makeReadCertificatesClient,
  READ_CERTIFICATE_ROLES,
} from "./CertificateBindingHttp.ts";
import { CertificateRead } from "./CertificateRead.ts";

/**
 * Implementation of {@link CertificateRead} over the distilled
 * `keyvault-certificates` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.CertificateRead
 */
export const CertificateReadHttp = Layer.effect(
  CertificateRead,
  makeCertificateLevelBinding({
    tag: "Azure.KeyVault.CertificateRead",
    roles: READ_CERTIFICATE_ROLES,
    makeClient: makeReadCertificatesClient,
  }),
);
