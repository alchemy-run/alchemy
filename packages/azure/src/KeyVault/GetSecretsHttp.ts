import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { GetSecrets } from "./GetSecrets.ts";
import { makeVaultSecretsHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link GetSecrets} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultReadSecretMetadataRole` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetSecrets
 */
export const GetSecretsHttp = Layer.effect(
  GetSecrets,
  makeVaultSecretsHttpBinding({
    tag: "Azure.KeyVault.GetSecrets",
    operation: secrets.GetSecrets,
    grants: [SecretRole.ReadSecretMetadata],
  }),
);
