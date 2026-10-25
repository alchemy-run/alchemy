import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultKeyOperationClient } from "./KeyTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * List the keys in a Key Vault, one page at a time (pass the previous page's
 * `nextLink` for the next one).
 *
 * Binding assigns a custom role with only `Microsoft.KeyVault/vaults/keys/read`
 * (one role definition per stack, shared by every host) on the vault.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link GetKeysHttp}.
 *
 * ### Listing Keys
 * **Example:** List the keys in a vault
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const getKeys = yield* Azure.KeyVault.GetKeys(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* getKeys({ maxresults: 25 });
 *         return yield* HttpServerResponse.json(page.value.map((k) => k.kid));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetKeysHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetKeys extends Binding.Service<
  GetKeys,
  "Azure.KeyVault.GetKeys",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultKeyOperationClient<keys.GetKeysRequest, keys.KeyListResult, keys.GetKeysError>
  >
> {}

export const GetKeys = Binding.Service<GetKeys>("Azure.KeyVault.GetKeys");
