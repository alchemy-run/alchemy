import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface DeleteSecretRequest extends Omit<
  secrets.DeleteSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Delete an Azure Key Vault secret (every version) from any host. On a vault
 * with soft delete the secret stays recoverable until its scheduled purge
 * date.
 *
 * Binding assigns a custom role (`AzureKeyVaultDeleteSecretRole`, one per stack)
 * with exactly the data action `secrets/delete`, on the secret only.
 * The smallest built-in role, **Key Vault Secrets Officer**, grants every
 * secret data action. Deleting a secret that an `Azure.KeyVault.Secret`
 * resource manages makes the next deploy fail until the secret is recovered
 * or purged.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteSecretHttp}.
 *
 * ### Calling DeleteSecret
 * **Example:** DeleteSecret from a Function
 * ```typescript
 * // init
 * const deleteSecret = yield* Azure.KeyVault.DeleteSecret(secret);
 *
 * // runtime
 * const deleted = yield* deleteSecret();
 * console.log(deleted.scheduledPurgeDate);
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DeleteSecret extends Binding.Service<
  DeleteSecret,
  "Azure.KeyVault.DeleteSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: DeleteSecretRequest,
    ) => Effect.Effect<secrets.DeletedSecretBundle, secrets.DeleteSecretError, RuntimeContext>
  >
> {}

export const DeleteSecret = Binding.Service<DeleteSecret>("Azure.KeyVault.DeleteSecret");
