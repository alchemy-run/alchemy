import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { Encrypt } from "./Encrypt.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link Encrypt} client for one key (the EncryptHttp implementation). */
export const makeEncryptClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.Encrypt",
  operation: keys.Encrypt,
  role: KeyRoles.Encrypt,
  versioned: true,
});

/**
 * Implementation of {@link Encrypt} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/encrypt/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.Encrypt
 */
export const EncryptHttp = Layer.effect(Encrypt, makeEncryptClient);
