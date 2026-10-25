import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { GetDeletedSecret } from "./GetDeletedSecret.ts";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link GetDeletedSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultGetSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.GetDeletedSecret
 */
export const GetDeletedSecretHttp = Layer.effect(
  GetDeletedSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.GetDeletedSecret",
    operation: secrets.GetDeletedSecret,
    grants: [SecretRole.GetSecret],
  }),
);
