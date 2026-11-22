import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Read the pending create operation of a certificate in a Key Vault (its
 * `status`, CSR, and error). Fails with `PendingCertificateNotFound` when
 * there is none.
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
 * Provide {@link GetCertificateOperationHttp}.
 *
 * ### Polling Creation
 * **Example:** Read a certificate's creation status
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const getCertificateOperation = yield* Azure.KeyVault.GetCertificateOperation(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const operation = yield* getCertificateOperation({ certificateName: "api-tls" });
 *         return yield* HttpServerResponse.json({ status: operation.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetCertificateOperationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetCertificateOperation extends Binding.Service<
  GetCertificateOperation,
  "Azure.KeyVault.GetCertificateOperation",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.GetCertificateOperationRequest,
      certificates.CertificateOperation
    >
  >
> {}

export const GetCertificateOperation = Binding.Service<GetCertificateOperation>(
  "Azure.KeyVault.GetCertificateOperation",
);
