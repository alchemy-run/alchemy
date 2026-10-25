import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { GetSecretVersions } from "./GetSecretVersions.ts";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link GetSecretVersions} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultReadSecretMetadataRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.GetSecretVersions
 */
export const GetSecretVersionsHttp = Layer.effect(
  GetSecretVersions,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.GetSecretVersions",
    operation: secrets.GetSecretVersions,
    grants: [SecretRole.ReadSecretMetadata],
  }),
);
