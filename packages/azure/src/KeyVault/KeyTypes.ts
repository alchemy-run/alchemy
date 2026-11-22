import type { AzureOpError } from "@distilled.cloud/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Request of a key operation bound to one `Azure.KeyVault.Key`: the distilled
 * `keyvault-keys` request without `vaultBaseUrl` and `keyName`, which the
 * bound key supplies. `keyVersion` is optional and defaults to the latest
 * version.
 */
export type KeyOperationRequest<I> = Omit<I, "vaultBaseUrl" | "keyName" | "keyVersion"> &
  ("keyVersion" extends keyof I ? { keyVersion?: string } : {});

/**
 * Request of a vault-wide key operation bound to one `Azure.KeyVault.Vault`: the
 * distilled `keyvault-keys` request without `vaultBaseUrl`.
 */
export type VaultKeyOperationRequest<I> = Omit<I, "vaultBaseUrl">;

/** A runtime callable; the request is optional when every member is. */
export type KeyOperationCallable<Request, A, E> = {} extends Request
  ? (request?: Request) => Effect.Effect<A, E, RuntimeContext>
  : (request: Request) => Effect.Effect<A, E, RuntimeContext>;

/** Runtime client of a key operation bound to one key. */
export type KeyOperationClient<I, A, E = AzureOpError> = KeyOperationCallable<
  KeyOperationRequest<I>,
  A,
  E
>;

/** Runtime client of a vault-wide key operation bound to one vault. */
export type VaultKeyOperationClient<I, A, E = AzureOpError> = KeyOperationCallable<
  VaultKeyOperationRequest<I>,
  A,
  E
>;
