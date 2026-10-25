import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Update the management policy of a certificate in a Key Vault. The change
 * applies to the next version.
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
 * Provide {@link UpdateCertificatePolicyHttp}.
 *
 * ### Updating Policies
 * **Example:** Renew automatically 30 days before expiry
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const updateCertificatePolicy = yield* Azure.KeyVault.UpdateCertificatePolicy(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const policy = yield* updateCertificatePolicy({
 *           certificateName: "api-tls",
 *           lifetime_actions: [
 *             { trigger: { days_before_expiry: 30 }, action: { action_type: "AutoRenew" } },
 *           ],
 *         });
 *         return yield* HttpServerResponse.json(policy.lifetime_actions);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.UpdateCertificatePolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UpdateCertificatePolicy extends Binding.Service<
  UpdateCertificatePolicy,
  "Azure.KeyVault.UpdateCertificatePolicy",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<
      certificates.UpdateCertificatePolicyRequest,
      certificates.CertificatePolicy
    >
  >
> {}

export const UpdateCertificatePolicy = Binding.Service<UpdateCertificatePolicy>(
  "Azure.KeyVault.UpdateCertificatePolicy",
);
