import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Permanently delete a soft-deleted certificate in a Key Vault. Not
 * available on vaults with purge protection.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/purge/action` (one role definition
 * per stack, shared by every host) on the vault. The built-in **Key Vault
 * Certificates Officer** role is not used: it grants every certificate
 * action. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link PurgeDeletedCertificateHttp}.
 *
 * ### Purging Certificates
 * **Example:** Purge a deleted certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const purgeDeletedCertificate = yield* Azure.KeyVault.PurgeDeletedCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* purgeDeletedCertificate({ certificateName: "old-tls" });
 *         return HttpServerResponse.empty({ status: 204 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.PurgeDeletedCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface PurgeDeletedCertificate extends Binding.Service<
  PurgeDeletedCertificate,
  "Azure.KeyVault.PurgeDeletedCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.PurgeDeletedCertificateRequest,
      certificates.PurgeDeletedCertificateResponse
    >
  >
> {}

export const PurgeDeletedCertificate = Binding.Service<PurgeDeletedCertificate>(
  "Azure.KeyVault.PurgeDeletedCertificate",
);
