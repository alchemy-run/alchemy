import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Secret } from "./Secret.ts";
import type { ReadSecretClient } from "./SecretRead.ts";
import type { WriteSecretClient } from "./SecretWrite.ts";

/** Read + write client for one Key Vault secret. */
export interface ReadWriteSecretClient extends ReadSecretClient, WriteSecretClient {}

/**
 * Read and write an Azure Key Vault secret from any host.
 *
 * Binding assigns **Key Vault Secrets User** (`getSecret` +
 * `readMetadata`) and the custom `AzureKeyVaultSecretWriteRole`
 * (`setSecret` + `update`) on the secret only; together they are exactly
 * the data actions the client calls. Managed-identity hosts get the roles
 * on their identity; any other host gets an Entra service principal (see
 * `AzureBindings`). Provide {@link SecretReadWriteHttp}.
 *
 * ### Reading and Writing Secrets
 * **Example:** Rotate a token and read it back
 * ```typescript
 * // init
 * const token = yield* Azure.KeyVault.SecretReadWrite(secret);
 *
 * // runtime
 * const written = yield* token.set(Redacted.make(fresh));
 * const current = yield* token.get(written.version);
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface SecretReadWrite extends Binding.Service<
  SecretReadWrite,
  "Azure.KeyVault.SecretReadWrite",
  (secret: Secret) => Effect.Effect<ReadWriteSecretClient>
> {}

export const SecretReadWrite = Binding.Service<SecretReadWrite>("Azure.KeyVault.SecretReadWrite");
