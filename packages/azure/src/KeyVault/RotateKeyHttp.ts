import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { RotateKey } from "./RotateKey.ts";

/** Builds the {@link RotateKey} client for one key (the RotateKeyHttp implementation). */
export const makeRotateKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.RotateKey",
  operation: keys.RotateKey,
  role: KeyRoles.Rotate,
});

/**
 * Implementation of {@link RotateKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/rotate/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.RotateKey
 */
export const RotateKeyHttp = Layer.effect(RotateKey, makeRotateKeyClient);
