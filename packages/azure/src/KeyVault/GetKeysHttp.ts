import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { GetKeys } from "./GetKeys.ts";
import { KeyRoles, makeVaultKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link GetKeys} client for one vault (the GetKeysHttp implementation). */
export const makeGetKeysClient = makeVaultKeyOperationBinding({
  tag: "Azure.KeyVault.GetKeys",
  operation: keys.GetKeys,
  role: KeyRoles.Read,
});

/**
 * Implementation of {@link GetKeys} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only `Microsoft.KeyVault/vaults/keys/read`
 * on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetKeys
 */
export const GetKeysHttp = Layer.effect(GetKeys, makeGetKeysClient);
