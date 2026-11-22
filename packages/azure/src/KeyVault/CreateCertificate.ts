import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Start creating a new certificate (or a new version) in a Key Vault. The
 * result is the pending operation; a self-signed certificate completes in
 * seconds.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/create/action` (one role
 * definition per stack, shared by every host) on the vault. The built-in
 * **Key Vault Certificates Officer** role is not used: it grants every
 * certificate action. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link CreateCertificateHttp}.
 *
 * ### Creating Certificates
 * **Example:** Create a self-signed certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const createCertificate = yield* Azure.KeyVault.CreateCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const operation = yield* createCertificate({
 *           certificateName: "internal-tls",
 *           policy: {
 *             issuer: { name: "Self" },
 *             x509_props: { subject: "CN=internal.example.com", validity_months: 12 },
 *           },
 *         });
 *         return yield* HttpServerResponse.json({ status: operation.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.CreateCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface CreateCertificate extends Binding.Service<
  CreateCertificate,
  "Azure.KeyVault.CreateCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.CreateCertificateRequest, certificates.CertificateOperation>
  >
> {}

export const CreateCertificate = Binding.Service<CreateCertificate>(
  "Azure.KeyVault.CreateCertificate",
);
