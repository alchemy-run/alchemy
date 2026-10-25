import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { UpdateKey } from "./UpdateKey.ts";

/** Builds the {@link UpdateKey} client for one key (the UpdateKeyHttp implementation). */
export const makeUpdateKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.UpdateKey",
  operation: keys.UpdateKey,
  role: KeyRoles.Update,
  versioned: true,
});

/**
 * Implementation of {@link UpdateKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/update/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateKey
 */
export const UpdateKeyHttp = Layer.effect(UpdateKey, makeUpdateKeyClient);
