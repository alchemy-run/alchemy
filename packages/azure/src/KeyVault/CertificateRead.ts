import type { AzureOpError } from "@distilled.cloud/azure";
import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Vault } from "./Vault.ts";

/** Options of {@link ReadCertificatesClient.list}. */
export interface CertificateListOptions {
  /** Page size (Key Vault's default is 25). */
  maxresults?: number;
  /** Include certificates whose creation is still pending. */
  includePending?: boolean;
  /** The previous page's `nextLink`, for the next page. */
  nextLink?: string;
}

/** Options of {@link ReadCertificatesClient.versions}. */
export interface CertificateVersionsOptions {
  /** Page size (Key Vault's default is 25). */
  maxresults?: number;
  /** The previous page's `nextLink`, for the next page. */
  nextLink?: string;
}

/** Read client for the certificates in one Key Vault. */
export interface ReadCertificatesClient {
  /** The latest (or a specific) version of a certificate; `undefined` when it does not exist. */
  get(
    certificateName: string,
    version?: string,
  ): Effect.Effect<certificates.CertificateBundle | undefined, AzureOpError, RuntimeContext>;
  /** A certificate's management policy; `undefined` when the certificate does not exist. */
  policy(
    certificateName: string,
  ): Effect.Effect<certificates.CertificatePolicy | undefined, AzureOpError, RuntimeContext>;
  /** A certificate's pending create operation; `undefined` when there is none. */
  operation(
    certificateName: string,
  ): Effect.Effect<certificates.CertificateOperation | undefined, AzureOpError, RuntimeContext>;
  /** One page of the vault's certificates. */
  list(
    options?: CertificateListOptions,
  ): Effect.Effect<certificates.CertificateListResult, AzureOpError, RuntimeContext>;
  /** One page of a certificate's versions. */
  versions(
    certificateName: string,
    options?: CertificateVersionsOptions,
  ): Effect.Effect<certificates.CertificateListResult, AzureOpError, RuntimeContext>;
}

/**
 * Read the certificates in an Azure Key Vault (certificates, versions,
 * policies, pending operations) from any host.
 *
 * Built on {@link GetCertificate}, {@link GetCertificates},
 * {@link GetCertificateVersions}, {@link GetCertificatePolicy}, and
 * {@link GetCertificateOperation}: binding assigns one custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` (one role definition per
 * stack, shared by every host) on the vault. The built-in **Key Vault
 * Certificate User** role is not used: it also reads secret values (the
 * private key) and keys. The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default). On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity. On any other host (a Cloudflare Worker, an AWS Lambda) Alchemy
 * creates an Entra service principal for the host, assigns the role to it,
 * and binds its client secret into the host's env (see `AzureBindings`).
 * Provide {@link CertificateReadHttp}.
 *
 * ### Reading Certificates
 * **Example:** Report when a certificate expires
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const certs = yield* Azure.KeyVault.CertificateRead(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const cert = yield* certs.get("api-tls");
 *         return yield* HttpServerResponse.json({ expires: cert?.attributes?.exp });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.CertificateReadHttp)),
 * ) {}
 * ```
 *
 * **Example:** List the vault's certificates
 * ```typescript
 * const page = yield* certs.list({ maxresults: 10 });
 * const thumbprints = page.value.map((item) => item.x5t);
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface CertificateRead extends Binding.Service<
  CertificateRead,
  "Azure.KeyVault.CertificateRead",
  (vault: Vault) => Effect.Effect<ReadCertificatesClient>
> {}

export const CertificateRead = Binding.Service<CertificateRead>("Azure.KeyVault.CertificateRead");
