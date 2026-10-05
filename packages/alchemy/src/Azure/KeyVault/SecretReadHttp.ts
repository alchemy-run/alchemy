import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  AzureDataPlaneError,
  AzureDataRole,
  azureDataPlaneRequest,
  bindAzureHost,
  envSuffix,
} from "../Binding.ts";
import type { Secret } from "./Secret.ts";
import { SecretRead } from "./SecretRead.ts";

const KEY_VAULT_SCOPE = "https://vault.azure.net/.default";
const KEY_VAULT_API_VERSION = "7.4";

/**
 * HTTP implementation of {@link SecretRead}: the Key Vault REST API
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.KeyVault.SecretRead
 */
export const SecretReadHttp = Layer.effect(
  SecretRead,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (secret: Secret) {
      yield* bindAzureHost({
        tag: "Azure.KeyVault.SecretRead",
        resource: secret,
        env: {
          [`AZURE_KEYVAULT_SECRET_URI_${envSuffix(secret.LogicalId)}`]:
            secret.secretUri,
        },
        roleAssignments: [
          {
            roleDefinitionId: AzureDataRole.KeyVaultSecretsUser,
            scope: secret.secretId,
          },
        ],
      });
      const uri = yield* secret.secretUri;
      return {
        get: Effect.fn(`Azure.KeyVault.SecretRead(${secret.LogicalId}).get`)(
          function* (version?: string) {
            const base = (yield* uri).replace(/\/+$/, "");
            const res = yield* azureDataPlaneRequest(
              http,
              KEY_VAULT_SCOPE,
              HttpClientRequest.get(
                version ? `${base}/${encodeURIComponent(version)}` : base,
              ).pipe(
                HttpClientRequest.setUrlParams({
                  "api-version": KEY_VAULT_API_VERSION,
                }),
              ),
            );
            const value = yield* Effect.try({
              try: () => (JSON.parse(res.text) as { value?: unknown }).value,
              catch: (cause) =>
                new AzureDataPlaneError({
                  message: "Key Vault returned invalid JSON",
                  status: res.status,
                  code: undefined,
                  cause,
                }),
            });
            if (typeof value !== "string") {
              return yield* new AzureDataPlaneError({
                message: "Key Vault secret response has no value",
                status: res.status,
                code: undefined,
              });
            }
            return Redacted.make(value);
          },
        ),
      };
    });
  }),
);
