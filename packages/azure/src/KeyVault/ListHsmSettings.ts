import type * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedHsm } from "./ManagedHsm.ts";

/** `GetSettings` request without the HSM endpoint, which the bound HSM supplies. */
export interface ListHsmSettingsRequest extends Omit<admin.GetSettingsRequest, "vaultBaseUrl"> {}

/**
 * List the account settings of a Managed HSM (e.g. `AllowKeyManagementOperationsThroughARM`).
 *
 * Binding grants the host the built-in local role **Managed HSM Administrator** (the settings operations have no documented data action), assigned at the HSM scope
 * `/` with an `Azure.KeyVault.ManagedHsmRoleAssignment`. Managed HSM
 * data-plane access is the HSM's local RBAC, so the HSM must be activated
 * first. Provide {@link ListHsmSettingsHttp}.
 *
 * ### Reading Settings
 * **Example:** List the HSM settings
 * ```typescript
 * // init
 * const listSettings = yield* Azure.KeyVault.ListHsmSettings(hsm);
 *
 * // runtime
 * const { settings } = yield* listSettings();
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface ListHsmSettings extends Binding.Service<
  ListHsmSettings,
  "Azure.KeyVault.ListHsmSettings",
  (
    hsm: ManagedHsm,
  ) => Effect.Effect<
    (
      request?: ListHsmSettingsRequest,
    ) => Effect.Effect<admin.SettingsListResult, admin.GetSettingsError, RuntimeContext>
  >
> {}

export const ListHsmSettings = Binding.Service<ListHsmSettings>("Azure.KeyVault.ListHsmSettings");
