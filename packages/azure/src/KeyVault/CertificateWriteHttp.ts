import * as Layer from "effect/Layer";
import {
  makeCertificateLevelBinding,
  makeWriteCertificatesClient,
  WRITE_CERTIFICATE_ROLES,
} from "./CertificateBindingHttp.ts";
import { CertificateWrite } from "./CertificateWrite.ts";

/**
 * Implementation of {@link CertificateWrite} over the distilled
 * `keyvault-certificates` data plane. Assigns custom roles with only
 * `Microsoft.KeyVault/vaults/certificates/create/action`,
 * `…/import/action`, `…/update/action`, and `…/delete` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.CertificateWrite
 */
export const CertificateWriteHttp = Layer.effect(
  CertificateWrite,
  makeCertificateLevelBinding({
    tag: "Azure.KeyVault.CertificateWrite",
    roles: WRITE_CERTIFICATE_ROLES,
    makeClient: makeWriteCertificatesClient,
  }),
);
