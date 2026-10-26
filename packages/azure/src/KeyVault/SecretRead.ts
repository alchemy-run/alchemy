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

/** One version of a Key Vault secret, without its value. Times are Unix seconds. */
export interface SecretVersionInfo {
  /** Secret identifier, `https://{vault}.vault.azure.net/secrets/{name}/{version}`. */
  id: string | undefined;
  /** Version ID (the last segment of `id`). */
  version: string | undefined;
  /** Whether the version can be read. */
  enabled: boolean | undefined;
  /** Creation time. */
  created: number | undefined;
  /** Last update time. */
  updated: number | undefined;
  /** Not-before time. */
  notBefore: number | undefined;
  /** Expiry time. */
  expires: number | undefined;
  /** Content type hint. */
  contentType: string | undefined;
  /** Tags on the version. */
  tags: Record<string, string | undefined> | undefined;
}

/** Read client for one Key Vault secret. */
export interface ReadSecretClient {
  /** Read the latest (or a specific) version of the secret. */
  get(
    version?: string,
  ): Effect.Effect<Redacted.Redacted<string>, AzureOpError | SecretValueMissing, RuntimeContext>;
  /** List every version of the secret (metadata only, every page). */
  versions(): Effect.Effect<SecretVersionInfo[], AzureOpError, RuntimeContext>;
}

/**
 * Read an Azure Key Vault secret from any host.
 *
 * Binding assigns **Key Vault Secrets User** on the secret only (data
 * actions `secrets/getSecret/action` and `secrets/readMetadata/action`,
 * exactly what `get` and `versions` call). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default). On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity. On any other host (a Cloudflare Worker, an AWS Lambda) Alchemy
 * creates an Entra service principal for the host, assigns the role to it,
 * and binds its client secret into the host's env (see `AzureBindings`).
 * Provide {@link SecretReadHttp}.
 *
 * ### Reading Secrets
 * **Example:** Read an API key
 * ```typescript
 * // init
 * const apiKey = yield* Azure.KeyVault.SecretRead(secret);
 *
 * // runtime
 * const key = Redacted.value(yield* apiKey.get());
 * // …provided with Effect.provide(Azure.KeyVault.SecretReadHttp)
 * ```
 *
 * **Example:** List the secret's versions
 * ```typescript
 * const versions = yield* apiKey.versions();
 * const enabled = versions.filter((v) => v.enabled).map((v) => v.version);
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
