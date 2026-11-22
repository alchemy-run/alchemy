import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { GetKey } from "./GetKey.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link GetKey} client for one key (the GetKeyHttp implementation). */
export const makeGetKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.GetKey",
  operation: keys.GetKey,
  role: KeyRoles.Read,
  versioned: true,
});

/**
 * Implementation of {@link GetKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only `Microsoft.KeyVault/vaults/keys/read`
 * on the key.
 *
 * @layer
 * @provides Azure.KeyVault.GetKey
 */
export const GetKeyHttp = Layer.effect(GetKey, makeGetKeyClient);
