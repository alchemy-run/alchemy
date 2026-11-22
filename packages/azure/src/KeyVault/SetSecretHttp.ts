import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";
import { SetSecret } from "./SetSecret.ts";

/**
 * Implementation of {@link SetSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultSetSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.SetSecret
 */
export const SetSecretHttp = Layer.effect(
  SetSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.SetSecret",
    operation: secrets.SetSecret,
    grants: [SecretRole.SetSecret],
  }),
);
