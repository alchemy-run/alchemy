import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface UpdateSecretRequest extends Omit<
  secrets.UpdateSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Change the content type, tags, or attributes (enabled, not-before, expiry)
 * of one version of an Azure Key Vault secret from any host. The value never
 * changes.
 *
 * Binding assigns a custom role (`AzureKeyVaultUpdateSecretRole`, one per stack)
 * with exactly the data action `secrets/update/action`, on the secret only.
 * The smallest built-in role, **Key Vault Secrets Officer**, grants every
 * secret data action.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateSecretHttp}.
 *
 * ### Calling UpdateSecret
 * **Example:** UpdateSecret from a Function
 * ```typescript
 * // init
 * const updateSecret = yield* Azure.KeyVault.UpdateSecret(secret);
 *
 * // runtime
 * yield* updateSecret({ secretVersion: oldVersion, attributes: { enabled: false } });
 * // …provided with Effect.provide(Azure.KeyVault.UpdateSecretHttp)
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UpdateSecret extends Binding.Service<
  UpdateSecret,
  "Azure.KeyVault.UpdateSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request: UpdateSecretRequest,
    ) => Effect.Effect<secrets.SecretBundle, secrets.UpdateSecretError, RuntimeContext>
  >
> {}

export const UpdateSecret = Binding.Service<UpdateSecret>("Azure.KeyVault.UpdateSecret");
