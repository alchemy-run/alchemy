import * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Layer from "effect/Layer";
import { BackupKey } from "./BackupKey.ts";
import { KeyRoles, makeKeyOperationBinding } from "./KeyBindingHttp.ts";

/** Builds the {@link BackupKey} client for one key (the BackupKeyHttp implementation). */
export const makeBackupKeyClient = makeKeyOperationBinding({
  tag: "Azure.KeyVault.BackupKey",
  operation: keys.BackupKey,
  role: KeyRoles.Backup,
});

/**
 * Implementation of {@link BackupKey} over the distilled `keyvault-keys` data
 * plane. Assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/backup/action` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.BackupKey
 */
export const BackupKeyHttp = Layer.effect(BackupKey, makeBackupKeyClient);
