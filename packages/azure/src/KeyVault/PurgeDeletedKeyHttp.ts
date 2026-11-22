import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { PurgeDeletedKey } from "./PurgeDeletedKey.ts";

/** Builds the {@link PurgeDeletedKey} client for one key (the PurgeDeletedKeyHttp implementation). */
export const makePurgeDeletedKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.PurgeDeletedKey",
  operation: keys.PurgeDeletedKey,
  role: KeyRoles.Purge,
});

/**
 * Implementation of {@link PurgeDeletedKey} over the distilled `keyvault-keys`
 * data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/purge/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.PurgeDeletedKey
 */
export const PurgeDeletedKeyHttp = Layer.effect(PurgeDeletedKey, makePurgeDeletedKeyClient);
