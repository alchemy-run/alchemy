import * as Layer from "effect/Layer";
import { makeSecretLevelBinding, makeWriteSecretClient, SecretRole } from "./SecretBindingHttp.ts";
import { SecretWrite } from "./SecretWrite.ts";

/**
 * Implementation of {@link SecretWrite} over the distilled
 * `keyvault-secrets` data plane. Assigns the custom
 * `AzureKeyVaultSecretWriteRole` (`setSecret` + `update`) on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.SecretWrite
 */
export const SecretWriteHttp = Layer.effect(
  SecretWrite,
  makeSecretLevelBinding({
    tag: "Azure.KeyVault.SecretWrite",
    grants: [SecretRole.SecretWrite],
    makeClient: makeWriteSecretClient,
  }),
);
