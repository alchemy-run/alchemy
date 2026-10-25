import type { AzureOpError } from "@distilled.cloud/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Request of a certificate operation bound to one `Azure.KeyVault.Vault`:
 * the distilled `keyvault-certificates` request without `vaultBaseUrl`,
 * which the bound vault supplies.
 */
export type VaultCertificateRequest<I> = Omit<I, "vaultBaseUrl">;

/** A runtime callable; the request is optional when every member is. */
export type VaultCertificateCallable<Request, A> = {} extends Request
  ? (request?: Request) => Effect.Effect<A, AzureOpError, RuntimeContext>
  : (request: Request) => Effect.Effect<A, AzureOpError, RuntimeContext>;

/** Runtime client of a certificate operation bound to one vault. */
export type VaultCertificateClient<I, A> = VaultCertificateCallable<VaultCertificateRequest<I>, A>;
