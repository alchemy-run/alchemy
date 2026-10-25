import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { UnwrapKey } from "./UnwrapKey.ts";

/** Builds the {@link UnwrapKey} client for one key (the UnwrapKeyHttp implementation). */
export const makeUnwrapKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.UnwrapKey",
  operation: keys.UnwrapKey,
  role: KeyRoles.Unwrap,
  versioned: true,
});

/**
 * Implementation of {@link UnwrapKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/unwrap/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.UnwrapKey
 */
export const UnwrapKeyHttp = Layer.effect(UnwrapKey, makeUnwrapKeyClient);
