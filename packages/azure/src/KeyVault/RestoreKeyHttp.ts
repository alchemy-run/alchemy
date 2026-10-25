import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeVaultKeyOperationBinding } from "./KeyBindingHttp.ts";
import { RestoreKey } from "./RestoreKey.ts";

/** Builds the {@link RestoreKey} client for one vault (the RestoreKeyHttp implementation). */
export const makeRestoreKeyClient = makeVaultKeyOperationBinding({
  tag: "Azure.KeyVault.RestoreKey",
  operation: keys.RestoreKey,
  role: KeyRoles.Restore,
});

/**
 * Implementation of {@link RestoreKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/restore/action` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.RestoreKey
 */
export const RestoreKeyHttp = Layer.effect(RestoreKey, makeRestoreKeyClient);
