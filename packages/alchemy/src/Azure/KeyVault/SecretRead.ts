import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type {
  AzureDataPlaneError,
  AzureManagedIdentityError,
} from "../Binding.ts";
import type { Secret } from "./Secret.ts";

/** Read client for one Key Vault secret. */
export interface ReadSecretClient {
  /** Read the latest (or a specific) version of the secret. */
  get(
    version?: string,
  ): Effect.Effect<
    Redacted.Redacted<string>,
    AzureDataPlaneError | AzureManagedIdentityError,
    RuntimeContext
  >;
}

/**
 * Read an Azure Key Vault secret from a Container App or Function App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Key Vault Secrets User** on the secret only. The vault must use Azure
 * RBAC (`enableRbacAuthorization: true`). Provide {@link SecretReadHttp}.
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

export const SecretRead = Binding.Service<SecretRead>(
  "Azure.KeyVault.SecretRead",
);
