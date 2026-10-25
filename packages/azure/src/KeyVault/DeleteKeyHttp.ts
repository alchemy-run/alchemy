import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { DeleteKey } from "./DeleteKey.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link DeleteKey} client for one key (the DeleteKeyHttp implementation). */
export const makeDeleteKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.DeleteKey",
  operation: keys.DeleteKey,
  role: KeyRoles.Delete,
});

/**
 * Implementation of {@link DeleteKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/delete` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteKey
 */
export const DeleteKeyHttp = Layer.effect(DeleteKey, makeDeleteKeyClient);
