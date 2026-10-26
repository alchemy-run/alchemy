import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Vault } from "./Vault.ts";

export interface RestoreSecretRequest extends Omit<secrets.RestoreSecretRequest, "vaultBaseUrl"> {}

/**
 * Restore a secret (every version) into an Azure Key Vault from a {@link
 * BackupSecret} blob, from any host. The secret name must not exist in the
 * vault, not even soft-deleted.
 *
 * Binding assigns a custom role (`AzureKeyVaultRestoreSecretRole`, one per stack)
 * with exactly the data action `secrets/restore/action`, on the vault only.
 * The binding is scoped to the vault because the restored secret does not
 * exist yet. The smallest built-in role, **Key Vault Secrets Officer**,
 * grants every secret data action.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestoreSecretHttp}.
 *
 * ### Calling RestoreSecret
 * **Example:** RestoreSecret from a Function
 * ```typescript
 * // init
 * const restore = yield* Azure.KeyVault.RestoreSecret(vault);
 *
 * // runtime
 * const restored = yield* restore({ value: blob });
 * // …provided with Effect.provide(Azure.KeyVault.RestoreSecretHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface RestoreSecret extends Binding.Service<
  RestoreSecret,
  "Azure.KeyVault.RestoreSecret",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: RestoreSecretRequest,
    ) => Effect.Effect<secrets.SecretBundle, secrets.RestoreSecretError, RuntimeContext>
  >
> {}

export const RestoreSecret = Binding.Service<RestoreSecret>("Azure.KeyVault.RestoreSecret");
