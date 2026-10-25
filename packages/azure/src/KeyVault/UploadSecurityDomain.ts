import type * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `UploadHSMSecurityDomain` request without the HSM endpoint, which the bound HSM supplies. */
export interface UploadSecurityDomainRequest extends Omit<
  securityDomain.UploadHSMSecurityDomainRequest,
  "vaultBaseUrl"
> {}

/**
 * Upload a security domain into a Managed HSM (restore after disaster recovery). `value` is the security domain re-encrypted to the HSM's exchange key.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/upload/action`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link UploadSecurityDomainHttp}.
 *
 * ### Restoring a Security Domain
 * **Example:** Upload a security domain
 * ```typescript
 * // init
 * const upload = yield* Azure.KeyVault.UploadSecurityDomain(hsm);
 *
 * // runtime
 * yield* upload({ value: restoreBlob });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UploadSecurityDomain extends Binding.Service<
  UploadSecurityDomain,
  "Azure.KeyVault.UploadSecurityDomain",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: UploadSecurityDomainRequest,
    ) => Effect.Effect<
      securityDomain.UploadHSMSecurityDomainResponse,
      securityDomain.UploadHSMSecurityDomainError,
      RuntimeContext
    >
  >
> {}

export const UploadSecurityDomain = Binding.Service<UploadSecurityDomain>(
  "Azure.KeyVault.UploadSecurityDomain",
);
