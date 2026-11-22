import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface GetSecretVersionsRequest extends Omit<
  secrets.GetSecretVersionsRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * List the versions of an Azure Key Vault secret (metadata only, one page
 * per call) from any host.
 *
 * Binding assigns a custom role (`AzureKeyVaultReadSecretMetadataRole`, one per stack, shared with the other metadata-read bindings)
 * with exactly the data action `secrets/readMetadata/action`, on the secret only.
 * The smallest built-in role, **Key Vault Reader**, also reads every other
 * object in the vault. Pass the returned `nextLink` to read the next page.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSecretVersionsHttp}.
 *
 * ### Calling GetSecretVersions
 * **Example:** GetSecretVersions from a Function
 * ```typescript
 * // init
 * const getVersions = yield* Azure.KeyVault.GetSecretVersions(secret);
 *
 * // runtime
 * const page = yield* getVersions({ maxresults: 25 });
 * const ids = page.value.map((v) => v.id);
 * // …provided with Effect.provide(Azure.KeyVault.GetSecretVersionsHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetSecretVersions extends Binding.Service<
  GetSecretVersions,
  "Azure.KeyVault.GetSecretVersions",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: GetSecretVersionsRequest,
    ) => Effect.Effect<secrets.SecretListResult, secrets.GetSecretVersionsError, RuntimeContext>
  >
> {}

export const GetSecretVersions = Binding.Service<GetSecretVersions>(
  "Azure.KeyVault.GetSecretVersions",
);
