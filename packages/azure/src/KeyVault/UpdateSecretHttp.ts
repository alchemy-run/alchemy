import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";
import { UpdateSecret } from "./UpdateSecret.ts";

/**
 * Implementation of {@link UpdateSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultUpdateSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.UpdateSecret
 */
export const UpdateSecretHttp = Layer.effect(
  UpdateSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.UpdateSecret",
    operation: secrets.UpdateSecret,
    grants: [SecretRole.UpdateSecret],
  }),
);
