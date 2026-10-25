import type * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `DownloadHSMSecurityDomain` request without the HSM endpoint, which the bound HSM supplies. */
export interface DownloadSecurityDomainRequest extends Omit<
  securityDomain.DownloadHSMSecurityDomainRequest,
  "vaultBaseUrl"
> {}

/**
 * Download a Managed HSM's security domain, encrypted to 3-10 RSA public keys; the first download activates the HSM.
 *
 * `required` is the quorum of private keys needed to restore it (at least 2). The response `value` is the encrypted security domain: store it offline with the private keys. Poll {@link GetSecurityDomainDownloadStatus} until it reports `Success`.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/download/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link DownloadSecurityDomainHttp}.
 *
 * ### Activating an HSM
 * **Example:** Download the security domain
 * ```typescript
 * // init
 * const download = yield* Azure.KeyVault.DownloadSecurityDomain(hsm);
 *
 * // runtime
 * // certificates: SecurityDomainJsonWebKey[] (kty "RSA", n, e, x5c, x5t#S256)
 * const { value } = yield* download({ certificates, required: 2 });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DownloadSecurityDomain extends Binding.Service<
  DownloadSecurityDomain,
  "Azure.KeyVault.DownloadSecurityDomain",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: DownloadSecurityDomainRequest,
    ) => Effect.Effect<
      securityDomain.DownloadHSMSecurityDomainResponse,
      securityDomain.DownloadHSMSecurityDomainError,
      RuntimeContext
    >
  >
> {}

export const DownloadSecurityDomain = Binding.Service<DownloadSecurityDomain>(
  "Azure.KeyVault.DownloadSecurityDomain",
);
