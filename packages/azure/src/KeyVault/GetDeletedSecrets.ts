import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Vault } from "./Vault.ts";

export interface GetDeletedSecretsRequest extends Omit<
  secrets.GetDeletedSecretsRequest,
  "vaultBaseUrl"
> {}

/**
 * List the soft-deleted secrets in an Azure Key Vault (one page per call)
 * from any host.
 *
 * Binding assigns a custom role (`AzureKeyVaultReadSecretMetadataRole`, one per stack, shared with the other metadata-read bindings)
 * with exactly the data action `secrets/readMetadata/action`, on the vault only.
 * The binding is scoped to the vault because the list covers every deleted
 * secret in it. The smallest built-in role, **Key Vault Reader**, also reads
 * keys and certificates. Pass the returned `nextLink` to read the next page.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDeletedSecretsHttp}.
 *
 * ### Calling GetDeletedSecrets
 * **Example:** GetDeletedSecrets from a Function
 * ```typescript
 * // init
 * const listDeleted = yield* Azure.KeyVault.GetDeletedSecrets(vault);
 *
 * // runtime
 * const page = yield* listDeleted();
 * const recoverable = page.value.map((s) => s.recoveryId);
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetDeletedSecrets extends Binding.Service<
  GetDeletedSecrets,
  "Azure.KeyVault.GetDeletedSecrets",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request?: GetDeletedSecretsRequest,
    ) => Effect.Effect<
      secrets.DeletedSecretListResult,
      secrets.GetDeletedSecretsError,
      RuntimeContext
    >
  >
> {}

export const GetDeletedSecrets = Binding.Service<GetDeletedSecrets>(
  "Azure.KeyVault.GetDeletedSecrets",
);
