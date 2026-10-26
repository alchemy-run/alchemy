import type * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `TransferHSMSecurityDomainKey` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetSecurityDomainTransferKeyRequest extends Omit<
  securityDomain.TransferHSMSecurityDomainKeyRequest,
  "vaultBaseUrl"
> {}

/**
 * Read the exchange key a security domain must be encrypted to before {@link UploadSecurityDomain} (disaster recovery into a new HSM).
 *
 * Binding grants the host a custom local role (one per HSM, shared by every host) with exactly `Microsoft.KeyVault/managedHsm/securitydomain/transferkey/read`, assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetSecurityDomainTransferKeyHttp}.
 *
 * ### Restoring a Security Domain
 * **Example:** Get the exchange key
 * ```typescript
 * // init
 * const transferKey = yield* Azure.KeyVault.GetSecurityDomainTransferKey(hsm);
 *
 * // runtime
 * const { transfer_key } = yield* transferKey();
 * // …provided with Effect.provide(Azure.KeyVault.GetSecurityDomainTransferKeyHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetSecurityDomainTransferKey extends Binding.Service<
  GetSecurityDomainTransferKey,
  "Azure.KeyVault.GetSecurityDomainTransferKey",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request?: GetSecurityDomainTransferKeyRequest,
    ) => Effect.Effect<
      securityDomain.TransferKey,
      securityDomain.TransferHSMSecurityDomainKeyError,
      RuntimeContext
    >
  >
> {}

export const GetSecurityDomainTransferKey = Binding.Service<GetSecurityDomainTransferKey>(
  "Azure.KeyVault.GetSecurityDomainTransferKey",
);
