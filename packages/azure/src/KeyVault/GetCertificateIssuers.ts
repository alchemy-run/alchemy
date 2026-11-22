import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * List the certificate issuers of a Key Vault, one page at a time.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificatecas/read` (one role definition per
 * stack, shared by every host) on the vault. The built-in **Key Vault
 * Certificates Officer** role is not used: it grants every certificate
 * action. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link GetCertificateIssuersHttp}.
 *
 * ### Listing Issuers
 * **Example:** List issuers
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const getCertificateIssuers = yield* Azure.KeyVault.GetCertificateIssuers(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* getCertificateIssuers();
 *         return yield* HttpServerResponse.json(page.value.map((item) => item.provider));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetCertificateIssuersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetCertificateIssuers extends Binding.Service<
  GetCertificateIssuers,
  "Azure.KeyVault.GetCertificateIssuers",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.GetCertificateIssuersRequest,
      certificates.CertificateIssuerListResult
    >
  >
> {}

export const GetCertificateIssuers = Binding.Service<GetCertificateIssuers>(
  "Azure.KeyVault.GetCertificateIssuers",
);
