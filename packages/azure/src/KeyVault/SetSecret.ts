import type * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";

export interface SetSecretRequest extends Omit<
  secrets.SetSecretRequest,
  "vaultBaseUrl" | "secretName"
> {}

/**
 * Write a new version of an Azure Key Vault secret from any host.
 *
 * Binding assigns a custom role (`AzureKeyVaultSetSecretRole`, one per stack)
 * with exactly the data action `secrets/setSecret/action`, on the secret only.
 * The smallest built-in role, **Key Vault Secrets Officer**, grants every
 * secret data action. A version written here is not tracked by the
 * `Azure.KeyVault.Secret` resource.
 * The vault must use Azure RBAC (`enableRbacAuthorization`, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SetSecretHttp}.
 *
 * ### Calling SetSecret
 * **Example:** SetSecret from a Function
 * ```typescript
 * // init
 * const setSecret = yield* Azure.KeyVault.SetSecret(secret);
 *
 * // runtime
 * const written = yield* setSecret({ value: fresh, contentType: "text/plain" });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface SetSecret extends Binding.Service<
  SetSecret,
  "Azure.KeyVault.SetSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request: SetSecretRequest,
    ) => Effect.Effect<secrets.SecretBundle, secrets.SetSecretError, RuntimeContext>
  >
> {}

export const SetSecret = Binding.Service<SetSecret>("Azure.KeyVault.SetSecret");
