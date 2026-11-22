import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Delete the certificate contacts of a Key Vault.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecontacts/write` (one role definition
 * per stack, shared by every host) on the vault. Key Vault has one data
 * action for reading, setting, and deleting contacts. The built-in **Key
 * Vault Certificates Officer** role is not used: it grants every certificate
 * action. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link DeleteCertificateContactsHttp}.
 *
 * ### Deleting Contacts
 * **Example:** Clear the contacts
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const deleteCertificateContacts = yield* Azure.KeyVault.DeleteCertificateContacts(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteCertificateContacts();
 *         return HttpServerResponse.empty({ status: 204 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.DeleteCertificateContactsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DeleteCertificateContacts extends Binding.Service<
  DeleteCertificateContacts,
  "Azure.KeyVault.DeleteCertificateContacts",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.DeleteCertificateContactsRequest, certificates.Contacts>
  >
> {}

export const DeleteCertificateContacts = Binding.Service<DeleteCertificateContacts>(
  "Azure.KeyVault.DeleteCertificateContacts",
);
