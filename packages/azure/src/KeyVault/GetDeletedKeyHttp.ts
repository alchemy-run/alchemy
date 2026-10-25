import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { GetDeletedKey } from "./GetDeletedKey.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link GetDeletedKey} client for one key (the GetDeletedKeyHttp implementation). */
export const makeGetDeletedKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.GetDeletedKey",
  operation: keys.GetDeletedKey,
  role: KeyRoles.Read,
});

/**
 * Implementation of {@link GetDeletedKey} over the distilled `keyvault-keys`
 * data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/read` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.GetDeletedKey
 */
export const GetDeletedKeyHttp = Layer.effect(GetDeletedKey, makeGetDeletedKeyClient);
