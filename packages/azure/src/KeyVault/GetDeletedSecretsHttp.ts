import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { GetDeletedSecrets } from "./GetDeletedSecrets.ts";
import { makeVaultSecretsHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link GetDeletedSecrets} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultReadSecretMetadataRole` on the vault.
 *
 * @layer
 * @provides Azure.KeyVault.GetDeletedSecrets
 */
export const GetDeletedSecretsHttp = Layer.effect(
  GetDeletedSecrets,
  makeVaultSecretsHttpBinding({
    tag: "Azure.KeyVault.GetDeletedSecrets",
    operation: secrets.GetDeletedSecrets,
    grants: [SecretRole.ReadSecretMetadata],
  }),
);
