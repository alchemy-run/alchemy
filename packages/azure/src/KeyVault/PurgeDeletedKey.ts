import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Permanently delete a soft-deleted Key Vault key. Vaults with purge protection
 * reject it until the retention period ends.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/purge/action` (one role definition per stack,
 * shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link PurgeDeletedKeyHttp}.
 *
 * ### Purging Keys
 * **Example:** Purge a deleted key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const purgeDeletedKey = yield* Azure.KeyVault.PurgeDeletedKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* purgeDeletedKey();
 *         return HttpServerResponse.text("purged");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.PurgeDeletedKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface PurgeDeletedKey extends Binding.Service<
  PurgeDeletedKey,
  "Azure.KeyVault.PurgeDeletedKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<
      keys.PurgeDeletedKeyRequest,
      keys.PurgeDeletedKeyResponse,
      keys.PurgeDeletedKeyError
    >
  >
> {}

export const PurgeDeletedKey = Binding.Service<PurgeDeletedKey>("Azure.KeyVault.PurgeDeletedKey");
