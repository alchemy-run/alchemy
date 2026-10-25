import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Secret } from "./Secret.ts";
import { SecretRead, SecretValueMissing } from "./SecretRead.ts";

/**
 * Implementation of {@link SecretRead} over the distilled
 * `keyvault-secrets` data plane. Assigns **Key Vault Secrets User** on the
 * secret.
 *
 * @layer
 * @provides Azure.KeyVault.SecretRead
 */
export const SecretReadHttp = Layer.effect(
  SecretRead,
  Effect.gen(function* () {
    const bind = yield* AzureBindings.Bind;
    const getSecret = yield* AzureBindings.withCredentials(secrets.GetSecret);
    return Effect.fn(function* (secret: Secret) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`Azure.KeyVault.SecretRead(${secret})`({
          roleAssignments: [
            { roleDefinitionId: BuiltInRole.KeyVaultSecretsUser, scope: secret.secretId },
          ],
        });
      }
      const vaultBaseUrl = yield* Output.interpolate`https://${secret.vault}.vault.azure.net`;
      const secretName = yield* secret.secretName;
      return {
        get: Effect.fn(`Azure.KeyVault.SecretRead(${secret.LogicalId}).get`)(function* (
          version?: string,
        ) {
          const name = yield* secretName;
          const base = yield* vaultBaseUrl;
          const bundle = yield* getSecret({
            vaultBaseUrl: base,
            secretName: name,
            secretVersion: version ?? "",
          });
          if (bundle.value === undefined) {
            return yield* new SecretValueMissing({
              secretName: name,
              message: `Key Vault secret ${name} has no value`,
            });
          }
          return Redacted.make(bundle.value);
        }),
      };
    });
  }),
);
