import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Back up a certificate in a Key Vault (every version) as an opaque blob
 * that {@link RestoreCertificate} accepts in a vault of the same
 * subscription and geography.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/backup/action` (one role
 * definition per stack, shared by every host) on the vault. The built-in
 * **Key Vault Certificates Officer** role is not used: it grants every
 * certificate action. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link BackupCertificateHttp}.
 *
 * ### Backing Up Certificates
 * **Example:** Back up a certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const backupCertificate = yield* Azure.KeyVault.BackupCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const backup = yield* backupCertificate({ certificateName: "api-tls" });
 *         return yield* HttpServerResponse.json({ blob: backup.value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.BackupCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface BackupCertificate extends Binding.Service<
  BackupCertificate,
  "Azure.KeyVault.BackupCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.BackupCertificateRequest,
      certificates.BackupCertificateResult
    >
  >
> {}

export const BackupCertificate = Binding.Service<BackupCertificate>(
  "Azure.KeyVault.BackupCertificate",
);
