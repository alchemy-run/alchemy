import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";
import { ReleaseKey } from "./ReleaseKey.ts";

/** Builds the {@link ReleaseKey} client for one key (the ReleaseKeyHttp implementation). */
export const makeReleaseKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.ReleaseKey",
  operation: keys.Release,
  role: KeyRoles.Release,
  versioned: true,
});

/**
 * Implementation of {@link ReleaseKey} over the distilled `keyvault-keys` data
 * plane. Assigns **Key Vault Crypto Service Release User** on the key.
 *
 * @layer
 * @provides Azure.KeyVault.ReleaseKey
 */
export const ReleaseKeyHttp = Layer.effect(ReleaseKey, makeReleaseKeyClient);
