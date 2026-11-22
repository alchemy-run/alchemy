import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Read the management policy of a certificate in a Key Vault (key, subject,
 * validity, issuer, lifetime actions).
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
 * Provide {@link GetCertificatePolicyHttp}.
 *
 * ### Reading Policies
 * **Example:** Read a certificate's subject
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const getCertificatePolicy = yield* Azure.KeyVault.GetCertificatePolicy(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const policy = yield* getCertificatePolicy({ certificateName: "api-tls" });
 *         return yield* HttpServerResponse.json({ subject: policy.x509_props?.subject });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetCertificatePolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetCertificatePolicy extends Binding.Service<
  GetCertificatePolicy,
  "Azure.KeyVault.GetCertificatePolicy",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.GetCertificatePolicyRequest, certificates.CertificatePolicy>
  >
> {}

export const GetCertificatePolicy = Binding.Service<GetCertificatePolicy>(
  "Azure.KeyVault.GetCertificatePolicy",
);
