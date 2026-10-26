import type { AzureOpError } from "@distilled.cloud/azure";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Secret } from "./Secret.ts";
import type { SecretVersionInfo } from "./SecretRead.ts";

/** Options for a secret version. Times are Unix seconds. */
export interface SecretWriteOptions {
  /** Content type hint, e.g. `text/plain`. */
  contentType?: string;
  /** Tags on the version. */
  tags?: Record<string, string>;
  /** Whether the version can be read. */
  enabled?: boolean;
  /** Not-before time. */
  notBefore?: number;
  /** Expiry time. */
  expires?: number;
}

/** Write client for one Key Vault secret. */
export interface WriteSecretClient {
  /** Write a new version of the secret; returns it without its value. */
  set(
    value: string | Redacted.Redacted<string>,
    options?: SecretWriteOptions,
  ): Effect.Effect<SecretVersionInfo, AzureOpError, RuntimeContext>;
  /**
   * Change the content type, tags, or attributes of one version. The value
   * of a version never changes; write a new one with `set`.
   */
  update(
    version: string,
    options: SecretWriteOptions,
  ): Effect.Effect<SecretVersionInfo, AzureOpError, RuntimeContext>;
}

/**
 * Write new versions of an Azure Key Vault secret from any host, e.g. to
 * rotate a credential.
 *
 * Binding assigns a custom role (`AzureKeyVaultSecretWriteRole`, one per
 * stack) with exactly the data actions `secrets/setSecret/action` and
 * `secrets/update/action`, on the secret only. The smallest built-in role
 * that covers them, **Key Vault Secrets Officer**, also grants delete and
 * purge. The vault must use Azure RBAC (`enableRbacAuthorization`, the
 * default). Managed-identity hosts get the role on their identity; any
 * other host gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SecretWriteHttp}.
 *
 * A version written here is not tracked by the `Azure.KeyVault.Secret`
 * resource: its next deploy writes the declared value again only if that
 * value changed.
 *
 * ### Writing Secrets
 * **Example:** Rotate a token
 * ```typescript
 * // init
 * const token = yield* Azure.KeyVault.SecretWrite(secret);
 *
 * // runtime
 * const written = yield* token.set(Redacted.make(fresh), { contentType: "text/plain" });
 * // …provided with Effect.provide(Azure.KeyVault.SecretWriteHttp)
 * ```
 *
 * **Example:** Disable an old version
 * ```typescript
 * yield* token.update(oldVersion, { enabled: false });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface SecretWrite extends Binding.Service<
  SecretWrite,
  "Azure.KeyVault.SecretWrite",
  (secret: Secret) => Effect.Effect<WriteSecretClient>
> {}

export const SecretWrite = Binding.Service<SecretWrite>("Azure.KeyVault.SecretWrite");
