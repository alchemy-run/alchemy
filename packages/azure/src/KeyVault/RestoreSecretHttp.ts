import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { RestoreSecret } from "./RestoreSecret.ts";
import { makeVaultSecretsHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link RestoreSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultRestoreSecretRole` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.RestoreSecret
 */
export const RestoreSecretHttp = Layer.effect(
  RestoreSecret,
  makeVaultSecretsHttpBinding({
    tag: "Azure.KeyVault.RestoreSecret",
    operation: secrets.RestoreSecret,
    grants: [SecretRole.RestoreSecret],
  }),
);
