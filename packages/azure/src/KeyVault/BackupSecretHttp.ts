import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { BackupSecret } from "./BackupSecret.ts";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link BackupSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultBackupSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.BackupSecret
 */
export const BackupSecretHttp = Layer.effect(
  BackupSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.BackupSecret",
    operation: secrets.BackupSecret,
    grants: [SecretRole.BackupSecret],
  }),
);
