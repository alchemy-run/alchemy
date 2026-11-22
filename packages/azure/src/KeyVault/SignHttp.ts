import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { Sign } from "./Sign.ts";

/** Builds the {@link Sign} client for one key (the SignHttp implementation). */
export const makeSignClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.Sign",
  operation: keys.Sign,
  role: KeyRoles.Sign,
  versioned: true,
});

/**
 * Implementation of {@link Sign} over the distilled `keyvault-keys` data plane.
 * Assigns a custom role with only `Microsoft.KeyVault/vaults/keys/sign/action`
 * on the key.
 *
 * @layer
 * @provides Azure.KeyVault.Sign
 */
export const SignHttp = Layer.effect(Sign, makeSignClient);
