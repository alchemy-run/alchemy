import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Restore a certificate (every version) into a Key Vault from a
 * {@link BackupCertificate} blob. The name must not exist in the vault
 * (purge a soft-deleted one first).
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/restore/action` (one role
 * definition per stack, shared by every host) on the vault. The built-in
 * **Key Vault Certificates Officer** role is not used: it grants every
 * certificate action. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link RestoreCertificateHttp}.
 *
 * ### Restoring Certificates
 * **Example:** Restore a backup
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const restoreCertificate = yield* Azure.KeyVault.RestoreCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const cert = yield* restoreCertificate({ value: blob });
 *         return yield* HttpServerResponse.json({ id: cert.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.RestoreCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface RestoreCertificate extends Binding.Service<
  RestoreCertificate,
  "Azure.KeyVault.RestoreCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.RestoreCertificateRequest, certificates.CertificateBundle>
  >
> {}

export const RestoreCertificate = Binding.Service<RestoreCertificate>(
  "Azure.KeyVault.RestoreCertificate",
);
