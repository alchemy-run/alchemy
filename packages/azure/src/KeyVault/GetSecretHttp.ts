import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { GetSecret } from "./GetSecret.ts";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link GetSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultGetSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.GetSecret
 */
export const GetSecretHttp = Layer.effect(
  GetSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.GetSecret",
    operation: secrets.GetSecret,
    grants: [SecretRole.GetSecret],
  }),
);
