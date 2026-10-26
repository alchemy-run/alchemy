import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface PurgeDeletedSecretRequest extends Omit<
  secrets.PurgeDeletedSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Permanently delete a soft-deleted Azure Key Vault secret from any host. It
 * cannot be recovered afterwards. The vault must not have purge protection.
 *
 * Binding assigns a custom role (`AzureKeyVaultPurgeDeletedSecretRole`, one per stack)
 * with exactly the data action `secrets/purge/action`, on the secret only.
 * The smallest built-in role, **Key Vault Secrets Officer**, grants every
 * secret data action.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PurgeDeletedSecretHttp}.
 *
 * ### Calling PurgeDeletedSecret
 * **Example:** PurgeDeletedSecret from a Function
 * ```typescript
 * // init
 * const purge = yield* Azure.KeyVault.PurgeDeletedSecret(secret);
 *
 * // runtime
 * yield* purge();
 * // …provided with Effect.provide(Azure.KeyVault.PurgeDeletedSecretHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface PurgeDeletedSecret extends Binding.Service<
  PurgeDeletedSecret,
  "Azure.KeyVault.PurgeDeletedSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: PurgeDeletedSecretRequest,
    ) => Effect.Effect<
      secrets.PurgeDeletedSecretResponse,
      secrets.PurgeDeletedSecretError,
      RuntimeContext
    >
  >
> {}

export const PurgeDeletedSecret = Binding.Service<PurgeDeletedSecret>(
  "Azure.KeyVault.PurgeDeletedSecret",
);
