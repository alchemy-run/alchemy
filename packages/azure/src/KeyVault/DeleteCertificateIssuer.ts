import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Delete a certificate issuer of a Key Vault.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecas/delete` (one role definition per
 * stack, shared by every host) on the vault. The built-in **Key Vault
 * Certificates Officer** role is not used: it grants every certificate
 * action. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link DeleteCertificateIssuerHttp}.
 *
 * ### Deleting Issuers
 * **Example:** Remove an issuer
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const deleteCertificateIssuer = yield* Azure.KeyVault.DeleteCertificateIssuer(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteCertificateIssuer({ issuerName: "digicert" });
 *         return HttpServerResponse.empty({ status: 204 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.DeleteCertificateIssuerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DeleteCertificateIssuer extends Binding.Service<
  DeleteCertificateIssuer,
  "Azure.KeyVault.DeleteCertificateIssuer",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.DeleteCertificateIssuerRequest, certificates.IssuerBundle>
  >
> {}

export const DeleteCertificateIssuer = Binding.Service<DeleteCertificateIssuer>(
  "Azure.KeyVault.DeleteCertificateIssuer",
);
