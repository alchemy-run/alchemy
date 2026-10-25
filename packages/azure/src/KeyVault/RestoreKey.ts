import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { VaultKeyOperationClient } from "./KeyTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Restore a key into a Key Vault from a {@link BackupKey} blob (same
 * subscription and geography). The key name must be free: not in use and not
 * soft-deleted.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/restore/action` (one role definition per
 * stack, shared by every host) on the vault.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link RestoreKeyHttp}.
 *
 * ### Restoring Keys
 * **Example:** Restore a backed-up key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const restoreKey = yield* Azure.KeyVault.RestoreKey(vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bundle = yield* restoreKey({ value: backupBlob });
 *         return yield* HttpServerResponse.json({ kid: bundle.key?.kid });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.RestoreKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface RestoreKey extends Binding.Service<
  RestoreKey,
  "Azure.KeyVault.RestoreKey",
  (
    vault: Vault,
  ) => Effect.Effect<
    VaultKeyOperationClient<keys.RestoreKeyRequest, keys.KeyBundle, keys.RestoreKeyError>
  >
> {}

export const RestoreKey = Binding.Service<RestoreKey>("Azure.KeyVault.RestoreKey");
