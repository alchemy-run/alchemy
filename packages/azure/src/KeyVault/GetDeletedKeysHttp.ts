import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { GetDeletedKeys } from "./GetDeletedKeys.ts";
import { KeyRoles, makeVaultKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link GetDeletedKeys} client for one vault (the GetDeletedKeysHttp implementation). */
export const makeGetDeletedKeysClient = makeVaultKeyOperationBinding({
  tag: "Azure.KeyVault.GetDeletedKeys",
  operation: keys.GetDeletedKeys,
  role: KeyRoles.Read,
});

/**
 * Implementation of {@link GetDeletedKeys} over the distilled `keyvault-keys`
 * data plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/read` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetDeletedKeys
 */
export const GetDeletedKeysHttp = Layer.effect(GetDeletedKeys, makeGetDeletedKeysClient);
