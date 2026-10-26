import type * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `DownloadHSMSecurityDomainPending` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetSecurityDomainDownloadStatusRequest extends Omit<
  securityDomain.DownloadHSMSecurityDomainPendingRequest,
  "vaultBaseUrl"
> {}

/**
 * Read the status of a Managed HSM security domain download (activation).
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/download/read`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetSecurityDomainDownloadStatusHttp}.
 *
 * ### Activating an HSM
 * **Example:** Wait for activation
 * ```typescript
 * // init
 * const downloadStatus = yield* Azure.KeyVault.GetSecurityDomainDownloadStatus(hsm);
 *
 * // runtime
 * const { status } = yield* downloadStatus();
 * // …provided with Effect.provide(Azure.KeyVault.GetSecurityDomainDownloadStatusHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetSecurityDomainDownloadStatus extends Binding.Service<
  GetSecurityDomainDownloadStatus,
  "Azure.KeyVault.GetSecurityDomainDownloadStatus",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request?: GetSecurityDomainDownloadStatusRequest,
    ) => Effect.Effect<
      securityDomain.SecurityDomainOperationStatus,
      securityDomain.DownloadHSMSecurityDomainPendingError,
      RuntimeContext
    >
  >
> {}

export const GetSecurityDomainDownloadStatus = Binding.Service<GetSecurityDomainDownloadStatus>(
  "Azure.KeyVault.GetSecurityDomainDownloadStatus",
);
