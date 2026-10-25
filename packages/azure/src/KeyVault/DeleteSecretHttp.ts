import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { DeleteSecret } from "./DeleteSecret.ts";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link DeleteSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultDeleteSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.DeleteSecret
 */
export const DeleteSecretHttp = Layer.effect(
  DeleteSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.DeleteSecret",
    operation: secrets.DeleteSecret,
    grants: [SecretRole.DeleteSecret],
  }),
);
