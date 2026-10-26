import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface GetSecretRequest extends Omit<
  secrets.GetSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Read the value of an Azure Key Vault secret (the latest version, or one
 * version) from any host.
 *
 * The secret's `value` comes back `Redacted`; read it with `Redacted.value`
 * where you use it.
 *
 * Binding assigns a custom role (`AzureKeyVaultGetSecretRole`, one per stack)
 * with exactly the data action `secrets/getSecret/action`, on the secret only.
 * The smallest built-in role, **Key Vault Secrets User**, also grants
 * `readMetadata`; use {@link SecretRead} for that role.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSecretHttp}.
 *
 * ### Calling GetSecret
 * **Example:** GetSecret from a Function
 * ```typescript
 * // init
 * const getSecret = yield* Azure.KeyVault.GetSecret(secret);
 *
 * // runtime
 * const latest = yield* getSecret();
 * const pinned = yield* getSecret({ secretVersion: version });
 * // latest.value is Redacted
 * // …provided with Effect.provide(Azure.KeyVault.GetSecretHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetSecret extends Binding.Service<
  GetSecret,
  "Azure.KeyVault.GetSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: GetSecretRequest,
    ) => Effect.Effect<secrets.SecretBundle, secrets.GetSecretError, RuntimeContext>
  >
> {}

export const GetSecret = Binding.Service<GetSecret>("Azure.KeyVault.GetSecret");
