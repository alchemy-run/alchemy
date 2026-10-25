import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `UpdateSetting` request without the HSM endpoint, which the bound HSM supplies. */
export interface UpdateHsmSettingRequest extends Omit<admin.UpdateSettingRequest, "vaultBaseUrl"> {}

/**
 * Change one account setting of a Managed HSM.
 *
 * Binding grants the host the built-in local role **Managed HSM Administrator** (the settings operations have no documented data action), assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link UpdateHsmSettingHttp}.
 *
 * ### Changing Settings
 * **Example:** Allow key management through ARM
 * ```typescript
 * // init
 * const updateSetting = yield* Azure.KeyVault.UpdateHsmSetting(hsm);
 *
 * // runtime
 * yield* updateSetting({
 *   settingName: "AllowKeyManagementOperationsThroughARM",
 *   value: "true",
 * });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UpdateHsmSetting extends Binding.Service<
  UpdateHsmSetting,
  "Azure.KeyVault.UpdateHsmSetting",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request: UpdateHsmSettingRequest,
    ) => Effect.Effect<admin.Setting, admin.UpdateSettingError, RuntimeContext>
  >
> {}

export const UpdateHsmSetting = Binding.Service<UpdateHsmSetting>(
  "Azure.KeyVault.UpdateHsmSetting",
);
