import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Delete every version of a certificate in a Key Vault (a soft delete on
 * vaults with soft-delete; see {@link RecoverDeletedCertificate} and
 * {@link PurgeDeletedCertificate}).
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/delete` (one role definition per
 * stack, shared by every host) on the vault. The built-in **Key Vault
 * Certificates Officer** role is not used: it grants every certificate
 * action. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link DeleteCertificateHttp}.
 *
 * ### Deleting Certificates
 * **Example:** Delete a certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const deleteCertificate = yield* Azure.KeyVault.DeleteCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const deleted = yield* deleteCertificate({ certificateName: "old-tls" });
 *         return yield* HttpServerResponse.json({ recoveryId: deleted.recoveryId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.DeleteCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DeleteCertificate extends Binding.Service<
  DeleteCertificate,
  "Azure.KeyVault.DeleteCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.DeleteCertificateRequest,
      certificates.DeletedCertificateBundle
    >
  >
> {}

export const DeleteCertificate = Binding.Service<DeleteCertificate>(
  "Azure.KeyVault.DeleteCertificate",
);
