import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface RecoverDeletedSecretRequest extends Omit<
  secrets.RecoverDeletedSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Recover a soft-deleted Azure Key Vault secret (every version) from any
 * host, before its scheduled purge date.
 *
 * Binding assigns a custom role (`AzureKeyVaultRecoverDeletedSecretRole`, one per stack)
 * with exactly the data action `secrets/recover/action`, on the secret only.
 * The smallest built-in role, **Key Vault Secrets Officer**, grants every
 * secret data action.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RecoverDeletedSecretHttp}.
 *
 * ### Calling RecoverDeletedSecret
 * **Example:** RecoverDeletedSecret from a Function
 * ```typescript
 * // init
 * const recover = yield* Azure.KeyVault.RecoverDeletedSecret(secret);
 *
 * // runtime
 * const restored = yield* recover();
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface RecoverDeletedSecret extends Binding.Service<
  RecoverDeletedSecret,
  "Azure.KeyVault.RecoverDeletedSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: RecoverDeletedSecretRequest,
    ) => Effect.Effect<secrets.SecretBundle, secrets.RecoverDeletedSecretError, RuntimeContext>
  >
> {}

export const RecoverDeletedSecret = Binding.Service<RecoverDeletedSecret>(
  "Azure.KeyVault.RecoverDeletedSecret",
);
