import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Vault } from "./Vault.ts";

export interface GetSecretsRequest extends Omit<secrets.GetSecretsRequest, "vaultBaseUrl"> {}

/**
 * List the secrets in an Azure Key Vault (metadata only, one page per call)
 * from any host.
 *
 * Binding assigns a custom role (`AzureKeyVaultReadSecretMetadataRole`, one per stack, shared with the other metadata-read bindings)
 * with exactly the data action `secrets/readMetadata/action`, on the vault only.
 * The binding is scoped to the vault because the list covers every secret in
 * it. The smallest built-in role, **Key Vault Reader**, also reads keys and
 * certificates. Pass the returned `nextLink` to read the next page.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSecretsHttp}.
 *
 * ### Calling GetSecrets
 * **Example:** GetSecrets from a Function
 * ```typescript
 * // init
 * const listSecrets = yield* Azure.KeyVault.GetSecrets(vault);
 *
 * // runtime
 * const page = yield* listSecrets();
 * const names = page.value.map((s) => s.id?.split("/").pop());
 * // …provided with Effect.provide(Azure.KeyVault.GetSecretsHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetSecrets extends Binding.Service<
  GetSecrets,
  "Azure.KeyVault.GetSecrets",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request?: GetSecretsRequest,
    ) => Effect.Effect<secrets.SecretListResult, secrets.GetSecretsError, RuntimeContext>
  >
> {}

export const GetSecrets = Binding.Service<GetSecrets>("Azure.KeyVault.GetSecrets");
