import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { ImportKey } from "./ImportKey.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link ImportKey} client for one key (the ImportKeyHttp implementation). */
export const makeImportKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.ImportKey",
  operation: keys.ImportKey,
  role: KeyRoles.Import,
});

/**
 * Implementation of {@link ImportKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/import/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.ImportKey
 */
export const ImportKeyHttp = Layer.effect(ImportKey, makeImportKeyClient);
