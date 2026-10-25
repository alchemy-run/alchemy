import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { RecoverDeletedKey } from "./RecoverDeletedKey.ts";

/** Builds the {@link RecoverDeletedKey} client for one key (the RecoverDeletedKeyHttp implementation). */
export const makeRecoverDeletedKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.RecoverDeletedKey",
  operation: keys.RecoverDeletedKey,
  role: KeyRoles.Recover,
});

/**
 * Implementation of {@link RecoverDeletedKey} over the distilled
 * `keyvault-keys` data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/recover/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.RecoverDeletedKey
 */
export const RecoverDeletedKeyHttp = Layer.effect(RecoverDeletedKey, makeRecoverDeletedKeyClient);
