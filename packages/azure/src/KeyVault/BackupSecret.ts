import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface BackupSecretRequest extends Omit<
  secrets.BackupSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Back up an Azure Key Vault secret (every version) from any host. The blob
 * can be restored with {@link RestoreSecret} into a vault in the same
 * subscription and geography.
 *
 * Binding assigns a custom role (`AzureKeyVaultBackupSecretRole`, one per stack)
 * with exactly the data action `secrets/backup/action`, on the secret only.
 * The smallest built-in role, **Key Vault Secrets Officer**, grants every
 * secret data action.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link BackupSecretHttp}.
 *
 * ### Calling BackupSecret
 * **Example:** BackupSecret from a Function
 * ```typescript
 * // init
 * const backupSecret = yield* Azure.KeyVault.BackupSecret(secret);
 *
 * // runtime
 * const { value: blob } = yield* backupSecret();
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface BackupSecret extends Binding.Service<
  BackupSecret,
  "Azure.KeyVault.BackupSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: BackupSecretRequest,
    ) => Effect.Effect<secrets.BackupSecretResult, secrets.BackupSecretError, RuntimeContext>
  >
> {}

export const BackupSecret = Binding.Service<BackupSecret>("Azure.KeyVault.BackupSecret");
