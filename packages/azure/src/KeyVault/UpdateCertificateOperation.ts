import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Request cancellation of the pending create operation of a certificate in
 * a Key Vault.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/certificates/update/action` (one role
 * definition per stack, shared by every host) on the vault. The built-in
 * **Key Vault Certificates Officer** role is not used: it grants every
 * certificate action. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for the
 * host, assigns the role to it, and binds its client secret into the host's
 * env (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link UpdateCertificateOperationHttp}.
 *
 * ### Cancelling Creation
 * **Example:** Cancel a pending certificate
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const updateCertificateOperation = yield* Azure.KeyVault.UpdateCertificateOperation(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const operation = yield* updateCertificateOperation({
 *           certificateName: "partner-tls",
 *           cancellation_requested: true,
 *         });
 *         return yield* HttpServerResponse.json({ status: operation.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.UpdateCertificateOperationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UpdateCertificateOperation extends Binding.Service<
  UpdateCertificateOperation,
  "Azure.KeyVault.UpdateCertificateOperation",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.UpdateCertificateOperationRequest,
      certificates.CertificateOperation
    >
  >
> {}

export const UpdateCertificateOperation = Binding.Service<UpdateCertificateOperation>(
  "Azure.KeyVault.UpdateCertificateOperation",
);
