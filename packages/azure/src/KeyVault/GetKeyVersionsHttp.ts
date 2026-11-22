import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { GetKeyVersions } from "./GetKeyVersions.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link GetKeyVersions} client for one key (the GetKeyVersionsHttp implementation). */
export const makeGetKeyVersionsClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.GetKeyVersions",
  operation: keys.GetKeyVersions,
  role: KeyRoles.Read,
});

/**
 * Implementation of {@link GetKeyVersions} over the distilled `keyvault-keys`
 * data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/read` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.GetKeyVersions
 */
export const GetKeyVersionsHttp = Layer.effect(GetKeyVersions, makeGetKeyVersionsClient);
