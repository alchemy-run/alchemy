import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `GetSetting` request without the HSM endpoint, which the bound HSM supplies. */
export interface GetHsmSettingRequest extends Omit<admin.GetSettingRequest, "vaultBaseUrl"> {}

/**
 * Read one account setting of a Managed HSM.
 *
 * Binding grants the host the built-in local role **Managed HSM Administrator** (the settings operations have no documented data action), assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link GetHsmSettingHttp}.
 *
 * ### Reading Settings
 * **Example:** Read one setting
 * ```typescript
 * // init
 * const getSetting = yield* Azure.KeyVault.GetHsmSetting(hsm);
 *
 * // runtime
 * const setting = yield* getSetting({ settingName: "AllowKeyManagementOperationsThroughARM" });
 * // …provided with Effect.provide(Azure.KeyVault.GetHsmSettingHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetHsmSetting extends Binding.Service<
  GetHsmSetting,
  "Azure.KeyVault.GetHsmSetting",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: GetHsmSettingRequest,
    ) => Effect.Effect<admin.Setting, admin.GetSettingError, RuntimeContext>
  >
> {}

export const GetHsmSetting = Binding.Service<GetHsmSetting>("Azure.KeyVault.GetHsmSetting");
