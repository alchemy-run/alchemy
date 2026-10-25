import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * List the soft-deleted certificates in a Key Vault, one page at a time.
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
 * Provide {@link GetDeletedCertificatesHttp}.
 *
 * ### Listing Deleted Certificates
 * **Example:** List deleted certificates
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const getDeletedCertificates = yield* Azure.KeyVault.GetDeletedCertificates(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* getDeletedCertificates();
 *         return yield* HttpServerResponse.json(page.value.map((item) => item.recoveryId));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetDeletedCertificatesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetDeletedCertificates extends Binding.Service<
  GetDeletedCertificates,
  "Azure.KeyVault.GetDeletedCertificates",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.GetDeletedCertificatesRequest,
      certificates.DeletedCertificateListResult
    >
  >
> {}

export const GetDeletedCertificates = Binding.Service<GetDeletedCertificates>(
  "Azure.KeyVault.GetDeletedCertificates",
);
