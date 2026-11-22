import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultKeyOperationClient } from "./KeyTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * List the soft-deleted keys in a Key Vault, one page at a time (pass the
 * previous page's `nextLink` for the next one).
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
 * Provide {@link GetDeletedKeysHttp}.
 *
 * ### Listing Deleted Keys
 * **Example:** List the deleted keys in a vault
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const getDeletedKeys = yield* Azure.KeyVault.GetDeletedKeys(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* getDeletedKeys();
 *         return yield* HttpServerResponse.json(page.value.map((k) => k.recoveryId));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetDeletedKeysHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetDeletedKeys extends Binding.Service<
  GetDeletedKeys,
  "Azure.KeyVault.GetDeletedKeys",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultKeyOperationClient<
      keys.GetDeletedKeysRequest,
      keys.DeletedKeyListResult,
      keys.GetDeletedKeysError
    >
  >
> {}

export const GetDeletedKeys = Binding.Service<GetDeletedKeys>("Azure.KeyVault.GetDeletedKeys");
