import type { AzureOpError } from "@distilled.cloud/azure";
import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Vault } from "./Vault.ts";

/** Options of {@link WriteCertificatesClient.create}. */
export type CertificateCreateOptions = Omit<
  certificates.CreateCertificateRequest,
  "vaultBaseUrl" | "certificateName"
>;

/** Options of {@link WriteCertificatesClient.import}. */
export type CertificateImportOptions = Omit<
  certificates.ImportCertificateRequest,
  "vaultBaseUrl" | "certificateName"
>;

/** Options of {@link WriteCertificatesClient.update}. */
export type CertificateUpdateOptions = Omit<
  certificates.UpdateCertificateRequest,
  "vaultBaseUrl" | "certificateName" | "certificateVersion"
> & {
  /** Version to update. @default the latest version */
  version?: string;
};

/** Options of {@link WriteCertificatesClient.updatePolicy}. */
export type CertificatePolicyUpdate = Omit<
  certificates.UpdateCertificatePolicyRequest,
  "vaultBaseUrl" | "certificateName"
>;

/** Write client for the certificates in one Key Vault. */
export interface WriteCertificatesClient {
  /**
   * Start creating a new certificate version. A new certificate needs a
   * `policy`. Self-signed (`issuer: { name: "Self" }`) certificates finish in
   * seconds; poll the returned operation's `status` until `completed`.
   */
  create(
    certificateName: string,
    options?: CertificateCreateOptions,
  ): Effect.Effect<certificates.CertificateOperation, AzureOpError, RuntimeContext>;
  /** Import a PFX (base64) or PEM certificate that contains its private key. */
  import(
    certificateName: string,
    options: CertificateImportOptions,
  ): Effect.Effect<certificates.CertificateBundle, AzureOpError, RuntimeContext>;
  /** Update a version's attributes and tags (the latest version by default). */
  update(
    certificateName: string,
    options: CertificateUpdateOptions,
  ): Effect.Effect<certificates.CertificateBundle, AzureOpError, RuntimeContext>;
  /** Update the certificate's management policy (applies to the next version). */
  updatePolicy(
    certificateName: string,
    policy: CertificatePolicyUpdate,
  ): Effect.Effect<certificates.CertificatePolicy, AzureOpError, RuntimeContext>;
  /**
   * Delete every version of a certificate (a soft delete on vaults with
   * soft-delete); `undefined` when it does not exist.
   */
  delete(
    certificateName: string,
  ): Effect.Effect<certificates.DeletedCertificateBundle | undefined, AzureOpError, RuntimeContext>;
}

/**
 * Create, import, update, and delete the certificates in an Azure Key Vault
 * from any host.
 *
 * Built on {@link CreateCertificate}, {@link ImportCertificate},
 * {@link UpdateCertificate}, {@link UpdateCertificatePolicy}, and
 * {@link DeleteCertificate}: binding assigns four custom roles on the vault,
 * one each with only `Microsoft.KeyVault/vaults/certificates/create/action`,
 * `…/certificates/import/action`, `…/certificates/update/action`, and
 * `…/certificates/delete` (one role definition each per stack, shared by
 * every host). The built-in **Key Vault Certificates Officer** role is not
 * used: it also grants purge, backup, restore, and issuer management. The
 * vault must use Azure RBAC (`enableRbacAuthorization`, the default). On a
 * host with a managed identity the roles go to that identity; on any other
 * host Alchemy creates an Entra service principal for it (see
 * `AzureBindings`). Provide {@link CertificateWriteHttp}.
 *
 * ### Writing Certificates
 * **Example:** Issue a self-signed certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const certs = yield* Azure.KeyVault.CertificateWrite(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const operation = yield* certs.create("internal-tls", {
 *           policy: {
 *             issuer: { name: "Self" },
 *             x509_props: { subject: "CN=internal.example.com", validity_months: 12 },
 *           },
 *         });
 *         return yield* HttpServerResponse.json({ status: operation.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.CertificateWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** Disable the latest version
 * ```typescript
 * yield* certs.update("internal-tls", { attributes: { enabled: false } });
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface CertificateWrite extends Binding.Service<
  CertificateWrite,
  "Azure.KeyVault.CertificateWrite",
  (vault: Vault) => Effect.Effect<WriteCertificatesClient>
> {}

export const CertificateWrite = Binding.Service<CertificateWrite>(
  "Azure.KeyVault.CertificateWrite",
);
