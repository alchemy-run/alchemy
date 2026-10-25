import type { AzureOpError } from "@distilled.cloud/azure";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Secret } from "./Secret.ts";

/** Key Vault returned a secret without a value (e.g. a disabled version). */
export class SecretValueMissing extends Data.TaggedError("Azure.KeyVault.SecretValueMissing")<{
  readonly secretName: string;
  readonly message: string;
}> {}

/** Read client for one Key Vault secret. */
export interface ReadSecretClient {
  /** Read the latest (or a specific) version of the secret. */
  get(
    version?: string,
  ): Effect.Effect<Redacted.Redacted<string>, AzureOpError | SecretValueMissing, RuntimeContext>;
}

/**
 * Read an Azure Key Vault secret from any host.
 *
 * Binding assigns **Key Vault Secrets User** on the secret only. The vault
 * must use Azure RBAC (`enableRbacAuthorization`, the default). On a host
 * with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity. On any other host (a Cloudflare Worker, an AWS
 * Lambda) Alchemy creates an Entra service principal for the host, assigns
 * the role to it, and binds its client secret into the host's env (see
 * `AzureBindings`). Provide {@link SecretReadHttp}.
 *
 * ### Reading Secrets
 * **Example:** Read an API key
 * ```typescript
 * // init
 * const apiKey = yield* Azure.KeyVault.SecretRead(secret);
 *
 * // runtime
 * const key = Redacted.value(yield* apiKey.get());
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface SecretRead extends Binding.Service<
  SecretRead,
  "Azure.KeyVault.SecretRead",
  (secret: Secret) => Effect.Effect<ReadSecretClient>
> {}

export const SecretRead = Binding.Service<SecretRead>("Azure.KeyVault.SecretRead");
