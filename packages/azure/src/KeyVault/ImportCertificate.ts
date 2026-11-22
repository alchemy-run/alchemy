import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Import a certificate with its private key into a Key Vault: a PFX as
 * base64, or PEM text with `policy.secret_props.contentType` set to
 * `application/x-pem-file`.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/import/action` (one role
 * definition per stack, shared by every host) on the vault. The built-in
 * **Key Vault Certificates Officer** role is not used: it grants every
 * certificate action. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link ImportCertificateHttp}.
 *
 * ### Importing Certificates
 * **Example:** Import a PEM certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const importCertificate = yield* Azure.KeyVault.ImportCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const cert = yield* importCertificate({
 *           certificateName: "imported-tls",
 *           value: pem,
 *           policy: { secret_props: { contentType: "application/x-pem-file" } },
 *         });
 *         return yield* HttpServerResponse.json({ x5t: cert.x5t });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.ImportCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface ImportCertificate extends Binding.Service<
  ImportCertificate,
  "Azure.KeyVault.ImportCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.ImportCertificateRequest, certificates.CertificateBundle>
  >
> {}

export const ImportCertificate = Binding.Service<ImportCertificate>(
  "Azure.KeyVault.ImportCertificate",
);
