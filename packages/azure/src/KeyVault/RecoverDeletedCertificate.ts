import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Recover a soft-deleted certificate in a Key Vault to its latest version,
 * within the vault's retention period.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/recover/action` (one role
 * definition per stack, shared by every host) on the vault. The built-in
 * **Key Vault Certificates Officer** role is not used: it grants every
 * certificate action. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link RecoverDeletedCertificateHttp}.
 *
 * ### Recovering Certificates
 * **Example:** Undo a delete
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const recoverDeletedCertificate = yield* Azure.KeyVault.RecoverDeletedCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const cert = yield* recoverDeletedCertificate({ certificateName: "old-tls" });
 *         return yield* HttpServerResponse.json({ id: cert.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.RecoverDeletedCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface RecoverDeletedCertificate extends Binding.Service<
  RecoverDeletedCertificate,
  "Azure.KeyVault.RecoverDeletedCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.RecoverDeletedCertificateRequest,
      certificates.CertificateBundle
    >
  >
> {}

export const RecoverDeletedCertificate = Binding.Service<RecoverDeletedCertificate>(
  "Azure.KeyVault.RecoverDeletedCertificate",
);
