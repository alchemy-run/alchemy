import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface GetDeletedSecretRequest extends Omit<
  secrets.GetDeletedSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Read a soft-deleted Azure Key Vault secret (its attributes, recovery ID,
 * and scheduled purge date) from any host.
 *
 * The secret's `value` comes back `Redacted`.
 *
 * Binding assigns a custom role (`AzureKeyVaultGetSecretRole`, one per
 * stack, shared with {@link GetSecret}) with exactly the data action
 * `secrets/getSecret/action`, on the secret only: Key Vault authorizes
 * reading a deleted secret with that action, not `readMetadata`. The
 * smallest built-in role, **Key Vault Secrets User**, also grants
 * `readMetadata`. The role assignment on the secret keeps applying after
 * the secret is deleted.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDeletedSecretHttp}.
 *
 * ### Calling GetDeletedSecret
 * **Example:** GetDeletedSecret from a Function
 * ```typescript
 * // init
 * const getDeleted = yield* Azure.KeyVault.GetDeletedSecret(secret);
 *
 * // runtime
 * const deleted = yield* getDeleted();
 * console.log(deleted.scheduledPurgeDate);
 * // …provided with Effect.provide(Azure.KeyVault.GetDeletedSecretHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetDeletedSecret extends Binding.Service<
  GetDeletedSecret,
  "Azure.KeyVault.GetDeletedSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: GetDeletedSecretRequest,
    ) => Effect.Effect<secrets.DeletedSecretBundle, secrets.GetDeletedSecretError, RuntimeContext>
  >
> {}

export const GetDeletedSecret = Binding.Service<GetDeletedSecret>(
  "Azure.KeyVault.GetDeletedSecret",
);
