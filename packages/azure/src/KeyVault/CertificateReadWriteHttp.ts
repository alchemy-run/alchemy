import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type CertificateAddress,
  makeCertificateLevelBinding,
  makeReadCertificatesClient,
  makeWriteCertificatesClient,
  READ_CERTIFICATE_ROLES,
  WRITE_CERTIFICATE_ROLES,
} from "./CertificateBindingHttp.ts";
import { CertificateReadWrite, type ReadWriteCertificatesClient } from "./CertificateReadWrite.ts";

/**
 * Implementation of {@link CertificateReadWrite} over the distilled
 * `keyvault-certificates` data plane. Assigns custom roles with only
 * `Microsoft.KeyVault/vaults/certificates/read`, `…/create/action`,
 * `…/import/action`, `…/update/action`, and `…/delete` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.CertificateReadWrite
 */
export const CertificateReadWriteHttp = Layer.effect(
  CertificateReadWrite,
  makeCertificateLevelBinding({
    tag: "Azure.KeyVault.CertificateReadWrite",
    roles: [...READ_CERTIFICATE_ROLES, ...WRITE_CERTIFICATE_ROLES],
    makeClient: Effect.gen(function* () {
      const makeRead = yield* makeReadCertificatesClient;
      const makeWrite = yield* makeWriteCertificatesClient;
      return (address: CertificateAddress): ReadWriteCertificatesClient => ({
        ...makeRead(address),
        ...makeWrite(address),
      });
    }),
  }),
);
