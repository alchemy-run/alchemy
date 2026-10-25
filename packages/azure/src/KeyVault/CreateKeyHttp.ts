import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { CreateKey } from "./CreateKey.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link CreateKey} client for one key (the CreateKeyHttp implementation). */
export const makeCreateKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.CreateKey",
  operation: keys.CreateKey,
  role: KeyRoles.Create,
});

/**
 * Implementation of {@link CreateKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/create/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.CreateKey
 */
export const CreateKeyHttp = Layer.effect(CreateKey, makeCreateKeyClient);
