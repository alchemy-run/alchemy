import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { Verify } from "./Verify.ts";

/** Builds the {@link Verify} client for one key (the VerifyHttp implementation). */
export const makeVerifyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.Verify",
  operation: keys.Verify,
  role: KeyRoles.Verify,
  versioned: true,
});

/**
 * Implementation of {@link Verify} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/verify/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.Verify
 */
export const VerifyHttp = Layer.effect(Verify, makeVerifyClient);
