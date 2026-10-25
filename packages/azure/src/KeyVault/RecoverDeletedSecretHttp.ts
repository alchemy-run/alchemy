import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { RecoverDeletedSecret } from "./RecoverDeletedSecret.ts";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link RecoverDeletedSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultRecoverDeletedSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.RecoverDeletedSecret
 */
export const RecoverDeletedSecretHttp = Layer.effect(
  RecoverDeletedSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.RecoverDeletedSecret",
    operation: secrets.RecoverDeletedSecret,
    grants: [SecretRole.RecoverDeletedSecret],
  }),
);
