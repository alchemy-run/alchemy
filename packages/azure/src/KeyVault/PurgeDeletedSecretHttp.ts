import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Layer from "effect/Layer";
import { PurgeDeletedSecret } from "./PurgeDeletedSecret.ts";
import { makeSecretHttpBinding, SecretRole } from "./SecretBindingHttp.ts";

/**
 * Implementation of {@link PurgeDeletedSecret} over the distilled `keyvault-secrets`
 * data plane. Assigns the custom `AzureKeyVaultPurgeDeletedSecretRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.PurgeDeletedSecret
 */
export const PurgeDeletedSecretHttp = Layer.effect(
  PurgeDeletedSecret,
  makeSecretHttpBinding({
    tag: "Azure.KeyVault.PurgeDeletedSecret",
    operation: secrets.PurgeDeletedSecret,
    grants: [SecretRole.PurgeDeletedSecret],
  }),
);
