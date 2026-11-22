import type * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultCertificateClient } from "./CertificateTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Update the attributes and tags of a certificate version in a Key Vault
 * (`certificateVersion: ""` updates the latest version).
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
 * Provide {@link UpdateCertificateHttp}.
 *
 * ### Updating Certificates
 * **Example:** Tag the latest version
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("certs");
 *     const updateCertificate = yield* Azure.KeyVault.UpdateCertificate(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const cert = yield* updateCertificate({
 *           certificateName: "api-tls",
 *           certificateVersion: "",
 *           tags: { rotated: "true" },
 *         });
 *         return yield* HttpServerResponse.json({ tags: cert.tags });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.UpdateCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UpdateCertificate extends Binding.Service<
  UpdateCertificate,
  "Azure.KeyVault.UpdateCertificate",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultCertificateClient<certificates.UpdateCertificateRequest, certificates.CertificateBundle>
  >
> {}

export const UpdateCertificate = Binding.Service<UpdateCertificate>(
  "Azure.KeyVault.UpdateCertificate",
);
