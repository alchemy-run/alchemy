import type { AzureOpError } from "@distilled.cloud/azure";
import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Request of a certificate operation bound to one `Azure.KeyVault.Vault`:
 * the distilled `keyvault-certificates` request without `vaultBaseUrl`,
 * which the bound vault supplies.
 */
export type VaultCertificateRequest<I> = Omit<I, "vaultBaseUrl">;

/**
 * Error of every `keyvault-certificates` operation: the module's typed errors
 * plus {@link AzureOpError}.
 */
export type CertificateError =
  | certificates.CertificateNotFound
  | certificates.PendingCertificateNotFound
  | certificates.CertificateIssuerNotFound
  | certificates.CertificateContactsNotFound
  | AzureOpError;

/** A runtime callable; the request is optional when every member is. */
export type VaultCertificateCallable<Request, A, E = CertificateError> = {} extends Request
  ? (request?: Request) => Effect.Effect<A, E, RuntimeContext>
  : (request: Request) => Effect.Effect<A, E, RuntimeContext>;

/** Runtime client of a certificate operation bound to one vault. */
export type VaultCertificateClient<I, A, E = CertificateError> = VaultCertificateCallable<
  VaultCertificateRequest<I>,
  A,
  E
>;
