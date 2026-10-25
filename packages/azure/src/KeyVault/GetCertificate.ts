import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Read a certificate in a Key Vault: the latest version, or `certificateVersion`
 * (its X.509 `cer`, thumbprint, policy, and attributes; not the private key).
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/read` (one role definition per
 * stack, shared by every host) on the vault. The built-in **Key Vault
 * Certificate User** role is not used: it also reads secret values (the
 * private key) and keys. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`). The vault must use Azure
 * RBAC (`enableRbacAuthorization`, the default).
 * Provide {@link GetCertificateHttp}.
 *
 * ### Reading Certificates
 * **Example:** Read a certificate's thumbprint
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const getCertificate = yield* Azure.KeyVault.GetCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const cert = yield* getCertificate({ certificateName: "api-tls" });
 *         return yield* HttpServerResponse.json({ x5t: cert.x5t, expires: cert.attributes?.exp });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetCertificate extends Binding.Service<
  GetCertificate,
  "Azure.KeyVault.GetCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.GetCertificateRequest, certificates.CertificateBundle>
  >
> {}

export const GetCertificate = Binding.Service<GetCertificate>("Azure.KeyVault.GetCertificate");
