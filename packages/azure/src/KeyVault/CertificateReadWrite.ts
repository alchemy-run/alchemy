import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadCertificatesClient } from "./CertificateRead.ts";
import type { WriteCertificatesClient } from "./CertificateWrite.ts";
import type { Vault } from "./Vault.ts";

/** Read + write client for the certificates in one Key Vault. */
export interface ReadWriteCertificatesClient
  extends ReadCertificatesClient, WriteCertificatesClient {}

/**
 * Read and write the certificates in an Azure Key Vault from any host.
 *
 * Combines {@link CertificateRead} and {@link CertificateWrite}: binding
 * assigns five custom roles on the vault, one each with only
 * `Microsoft.KeyVault/vaults/certificates/read`, `…/create/action`,
 * `…/import/action`, `…/update/action`, and `…/delete` (one role definition
 * each per stack, shared by every host). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default). On a host with a managed
 * identity the roles go to that identity; on any other host Alchemy creates
 * an Entra service principal for it (see `AzureBindings`).
 * Provide {@link CertificateReadWriteHttp}.
 *
 * ### Reading and Writing Certificates
 * **Example:** Issue a certificate and wait until it is ready
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const certs = yield* Azure.KeyVault.CertificateReadWrite(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* certs.create("worker-tls", {
 *           policy: { issuer: { name: "Self" }, x509_props: { subject: "CN=worker" } },
 *         });
 *         const operation = yield* certs.operation("worker-tls").pipe(
 *           Effect.repeat({
 *             schedule: Schedule.spaced("2 seconds"),
 *             until: (op) => op?.status !== "inProgress",
 *             times: 15,
 *           }),
 *         );
 *         const cert = yield* certs.get("worker-tls");
 *         return yield* HttpServerResponse.json({ status: operation?.status, x5t: cert?.x5t });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.CertificateReadWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface CertificateReadWrite extends Binding.Service<
  CertificateReadWrite,
  "Azure.KeyVault.CertificateReadWrite",
  (vault: Vault) => Effect.Effect<ReadWriteCertificatesClient>
> {}

export const CertificateReadWrite = Binding.Service<CertificateReadWrite>(
  "Azure.KeyVault.CertificateReadWrite",
);
