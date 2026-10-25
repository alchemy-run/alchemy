import type * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `UploadHSMSecurityDomainPending` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetSecurityDomainUploadStatusRequest extends Omit<
  securityDomain.UploadHSMSecurityDomainPendingRequest,
  "vaultBaseUrl"
> {}

/**
 * Read the status of a security domain upload started with {@link UploadSecurityDomain}.
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/upload/read`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetSecurityDomainUploadStatusHttp}.
 *
 * ### Restoring a Security Domain
 * **Example:** Wait for the upload
 * ```typescript
 * // init
 * const uploadStatus = yield* Azure.KeyVault.GetSecurityDomainUploadStatus(hsm);
 *
 * // runtime
 * const { status } = yield* uploadStatus();
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetSecurityDomainUploadStatus extends Binding.Service<
  GetSecurityDomainUploadStatus,
  "Azure.KeyVault.GetSecurityDomainUploadStatus",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request?: GetSecurityDomainUploadStatusRequest,
    ) => Effect.Effect<
      securityDomain.SecurityDomainOperationStatus,
      securityDomain.UploadHSMSecurityDomainPendingError,
      RuntimeContext
    >
  >
> {}

export const GetSecurityDomainUploadStatus = Binding.Service<GetSecurityDomainUploadStatus>(
  "Azure.KeyVault.GetSecurityDomainUploadStatus",
);
