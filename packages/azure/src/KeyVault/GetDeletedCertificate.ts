import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Read a soft-deleted certificate in a Key Vault (when it was deleted and
 * when it will be purged).
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
 * Provide {@link GetDeletedCertificateHttp}.
 *
 * ### Reading Deleted Certificates
 * **Example:** Read when a deleted certificate is purged
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const getDeletedCertificate = yield* Azure.KeyVault.GetDeletedCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const deleted = yield* getDeletedCertificate({ certificateName: "old-tls" });
 *         return yield* HttpServerResponse.json({ purgeAt: deleted.scheduledPurgeDate });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetDeletedCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetDeletedCertificate extends Binding.Service<
  GetDeletedCertificate,
  "Azure.KeyVault.GetDeletedCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.GetDeletedCertificateRequest,
      certificates.DeletedCertificateBundle
    >
  >
> {}

export const GetDeletedCertificate = Binding.Service<GetDeletedCertificate>(
  "Azure.KeyVault.GetDeletedCertificate",
);
