import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import {
  makeReadSecretClient,
  makeSecretLevelBinding,
  makeWriteSecretClient,
  type SecretAddress,
  SecretRole,
} from "./SecretBindingHttp.ts";
import { type ReadWriteSecretClient, SecretReadWrite } from "./SecretReadWrite.ts";

/**
 * Implementation of {@link SecretReadWrite} over the distilled
 * `keyvault-secrets` data plane. Assigns **Key Vault Secrets User** and
 * the custom `AzureKeyVaultSecretWriteRole` on the secret.
 *
 * @layer
 * @provides Azure.KeyVault.SecretReadWrite
 */
export const SecretReadWriteHttp = Layer.effect(
  SecretReadWrite,
  makeSecretLevelBinding({
    tag: "Azure.KeyVault.SecretReadWrite",
    grants: [{ builtIn: BuiltInRole.KeyVaultSecretsUser }, SecretRole.SecretWrite],
    makeClient: Effect.gen(function* () {
      const makeRead = yield* makeReadSecretClient;
      const makeWrite = yield* makeWriteSecretClient;
      return (address: SecretAddress): ReadWriteSecretClient => ({
        ...makeRead(address),
        ...makeWrite(address),
      });
    }),
  }),
);
