import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Merge a certificate (or chain) signed by an external CA into a pending
 * certificate in a Key Vault whose key pair the vault holds (a certificate
 * created with `issuer: { name: "Unknown" }`).
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
 * Provide {@link MergeCertificateHttp}.
 *
 * ### Merging Signed Certificates
 * **Example:** Merge the CA-signed certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const mergeCertificate = yield* Azure.KeyVault.MergeCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const cert = yield* mergeCertificate({ certificateName: "partner-tls", x5c: [signedBase64] });
 *         return yield* HttpServerResponse.json({ x5t: cert.x5t });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.MergeCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface MergeCertificate extends Binding.Service<
  MergeCertificate,
  "Azure.KeyVault.MergeCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.MergeCertificateRequest, certificates.CertificateBundle>
  >
> {}

export const MergeCertificate = Binding.Service<MergeCertificate>(
  "Azure.KeyVault.MergeCertificate",
);
