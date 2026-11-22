import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { WrapKey } from "./WrapKey.ts";

/** Builds the {@link WrapKey} client for one key (the WrapKeyHttp implementation). */
export const makeWrapKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.WrapKey",
  operation: keys.WrapKey,
  role: KeyRoles.Wrap,
  versioned: true,
});

/**
 * Implementation of {@link WrapKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/wrap/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.WrapKey
 */
export const WrapKeyHttp = Layer.effect(WrapKey, makeWrapKeyClient);
