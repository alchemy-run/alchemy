import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { Decrypt } from "./Decrypt.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link Decrypt} client for one key (the DecryptHttp implementation). */
export const makeDecryptClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.Decrypt",
  operation: keys.Decrypt,
  role: KeyRoles.Decrypt,
  versioned: true,
});

/**
 * Implementation of {@link Decrypt} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/decrypt/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.Decrypt
 */
export const DecryptHttp = Layer.effect(Decrypt, makeDecryptClient);
